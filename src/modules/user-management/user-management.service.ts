import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { UserRecord } from "firebase-admin/auth";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { SecurityEventsService } from "../auth/security-events.service";
import type { AuthenticatedUser } from "../auth/authenticated-user";
import type { UpdateManagedUserDto } from "./user-management.dto";
import { userManagementSummary } from "./user-management.summary";

export function pageSize(value?: string) {
  if (value !== undefined && typeof value !== "string")
    throw new BadRequestException("Invalid limit.");
  const size = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 100)
    throw new BadRequestException("limit must be between 1 and 100.");
  return size;
}

export function managedRoles(existing: unknown, role: string) {
  const managed = new Set(["user", "admin", "moderator", "support"]);
  const other = Array.isArray(existing)
    ? existing.filter(
        (value): value is string =>
          typeof value === "string" && !managed.has(value.trim().toLowerCase()),
      )
    : [];
  return [...other, role];
}

@Injectable()
export class UserManagementService {
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebase: FirebaseAdminService,
    @Inject(SecurityEventsService)
    private readonly security: SecurityEventsService,
  ) {}

  async session(actor: AuthenticatedUser) {
    const record = await this.firebase.auth().getUser(actor.uid);
    return {
      uid: actor.uid,
      email: actor.email,
      name: record.displayName || actor.email,
      roles: actor.roles,
    };
  }

  async list(input: { limit?: string; cursor?: string; search?: string }) {
    const limit = pageSize(input.limit);
    if (input.search !== undefined && typeof input.search !== "string")
      throw new BadRequestException("Invalid email search.");
    if (input.cursor !== undefined && typeof input.cursor !== "string")
      throw new BadRequestException("Invalid cursor.");
    const search = (input.search || "").trim().toLowerCase();
    if (search.length > 254 || search.includes("/"))
      throw new BadRequestException("Invalid email search.");
    if (
      input.cursor &&
      (input.cursor.length > 254 || input.cursor.includes("/"))
    )
      throw new BadRequestException("Invalid cursor.");
    let base = this.firebase
      .db()
      .collection("users")
      .orderBy(FieldPath.documentId());
    if (search)
      base = base
        .where(FieldPath.documentId(), ">=", search)
        .where(FieldPath.documentId(), "<=", `${search}\uf8ff`);
    const query = input.cursor ? base.startAfter(input.cursor) : base;
    const [snapshot, total] = await Promise.all([
      query.limit(limit + 1).get(),
      base.count().get(),
    ]);
    const docs = snapshot.docs.slice(0, limit);
    const emails = docs.map((doc) => doc.id);
    const authUsers = emails.length
      ? await this.firebase.auth().getUsers(emails.map((email) => ({ email })))
      : { users: [] };
    const byEmail = new Map(
      authUsers.users.map((user) => [user.email?.toLowerCase(), user]),
    );
    return {
      users: docs.map((doc) =>
        this.presentUser(doc.id, doc.data(), byEmail.get(doc.id.toLowerCase())),
      ),
      nextCursor:
        snapshot.docs.length > limit ? docs[docs.length - 1].id : null,
      total: total.data().count,
    };
  }

  summary(days: string = "30") {
    if (typeof days !== "string")
      throw new BadRequestException("Invalid date range.");
    const range = Number(days);
    if (![7, 30, 90].includes(range))
      throw new BadRequestException("days must be 7, 30, or 90.");
    return userManagementSummary(this.firebase.db(), range);
  }

  async update(
    uid: string,
    change: UpdateManagedUserDto,
    actor: AuthenticatedUser,
  ) {
    if (!uid || uid.length > 128 || uid.includes("/"))
      throw new BadRequestException("Invalid user ID.");
    if (uid === actor.uid)
      throw new ForbiddenException(
        "You cannot change your own access from user management.",
      );
    if (change.disabled === undefined && change.role === undefined)
      throw new BadRequestException("No account changes supplied.");
    const auth = this.firebase.auth();
    const target = await auth.getUser(uid);
    if (!target.email)
      throw new BadRequestException("This account has no email profile.");
    const profile = this.firebase
      .db()
      .collection("users")
      .doc(target.email.toLowerCase());
    const audit = this.firebase.db().collection("user_management_audit").doc();
    await audit.set({
      actor: actor.email,
      target: target.email,
      uid,
      change: { ...change },
      outcome: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
    try {
      if (change.role !== undefined) {
        await this.firebase.db().runTransaction(async (tx) => {
          const current = await tx.get(profile);
          if (!current.exists)
            throw new BadRequestException(
              "The central account profile is missing.",
            );
          tx.update(profile, {
            roles: managedRoles(current.data()?.roles, change.role!),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
      }
      if (change.disabled !== undefined)
        await auth.updateUser(uid, { disabled: change.disabled });
      if (change.role !== undefined || change.disabled === true) {
        await auth.revokeRefreshTokens(uid);
        await this.security.publishSubjectRevocation({
          uid,
          email: target.email,
          actor: actor.uid,
          reason: change.disabled ? "admin_suspended" : "admin_role_changed",
        });
      }
      await audit.update({
        outcome: "completed",
        completedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      await audit.update({
        outcome: "failed",
        completedAt: FieldValue.serverTimestamp(),
      });
      throw error;
    }
    return { ok: true };
  }

  async audit(cursor?: string) {
    if (cursor !== undefined && typeof cursor !== "string")
      throw new BadRequestException("Invalid audit cursor.");
    if (cursor && !/^[A-Za-z0-9]{1,128}$/.test(cursor))
      throw new BadRequestException("Invalid audit cursor.");
    let query = this.firebase
      .db()
      .collection("user_management_audit")
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (cursor) {
      const snapshot = await this.firebase
        .db()
        .collection("user_management_audit")
        .doc(cursor)
        .get();
      if (!snapshot.exists)
        throw new BadRequestException("Audit cursor no longer exists.");
      query = query.startAfter(snapshot);
    }
    const snapshot = await query.limit(26).get();
    const docs = snapshot.docs.slice(0, 25);
    return {
      events: docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: iso(doc.data().createdAt),
      })),
      nextCursor: snapshot.docs.length > 25 ? docs[24].id : null,
    };
  }

  private presentUser(
    email: string,
    profile: Record<string, unknown>,
    auth?: UserRecord,
  ) {
    const roles = Array.isArray(profile.roles)
      ? profile.roles.filter((role): role is string => typeof role === "string")
      : [];
    return {
      uid: auth?.uid || null,
      email,
      name:
        typeof profile.fullname === "string" && profile.fullname
          ? profile.fullname
          : auth?.displayName || email,
      roles,
      verified: auth?.emailVerified ?? false,
      status: !auth
        ? "Unavailable"
        : auth.disabled
          ? "Suspended"
          : auth.emailVerified
            ? "Active"
            : "Pending",
      createdAt: auth?.metadata.creationTime
        ? new Date(auth.metadata.creationTime).toISOString()
        : iso(profile.createdAt),
      lastLoginAt: iso(profile.lastLoginAt),
    };
  }
}

function iso(value: unknown): string | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === "function")
    return (value as { toDate: () => Date }).toDate().toISOString();
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
