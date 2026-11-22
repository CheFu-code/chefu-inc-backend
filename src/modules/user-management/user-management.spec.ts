import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { ExecutionContext } from "@nestjs/common";
import { validate } from "class-validator";
import type { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import type { SecurityEventsService } from "../auth/security-events.service";
import { AuthGuard } from "../auth/auth.guard";
import { UserManagementGuard } from "./user-management.guard";
import { UserManagementController } from "./user-management.controller";
import { UpdateManagedUserDto } from "./user-management.dto";
import {
  managedRoles,
  pageSize,
  UserManagementService,
} from "./user-management.service";
import { userManagementSummary } from "./user-management.summary";

const actor = { uid: "actor", email: "admin@example.test", roles: ["admin"] };

test("all management endpoints require authentication and fresh administrator access", () => {
  assert.deepEqual(
    Reflect.getMetadata(GUARDS_METADATA, UserManagementController),
    [AuthGuard, UserManagementGuard],
  );
});

test("admin session includes the profile photo or null when unavailable", async () => {
  let photoURL: string | null = "https://example.test/admin.jpg";
  const service = new UserManagementService(
    {
      auth: () => ({
        getUser: async () => ({
          displayName: "Admin",
          photoURL,
        }),
      }),
    } as unknown as FirebaseAdminService,
    {} as SecurityEventsService,
  );

  assert.deepEqual(await service.session(actor), {
    uid: actor.uid,
    email: actor.email,
    name: "Admin",
    photoURL,
    roles: actor.roles,
  });
  photoURL = null;
  assert.equal((await service.session(actor)).photoURL, null);
});

test("guard ignores stale signed admin claims, disabled administrators, and anonymous callers", async () => {
  let roles = ["user"];
  let disabled = false;
  const firebase = {
    db: () => ({
      collection: () => ({
        doc: () => ({ get: async () => ({ data: () => ({ roles }) }) }),
      }),
    }),
    auth: () => ({ getUser: async () => ({ disabled }) }),
  } as unknown as FirebaseAdminService;
  const guard = new UserManagementGuard(firebase);
  const context = (user?: typeof actor) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as ExecutionContext;
  await assert.rejects(
    guard.canActivate(context(actor)),
    /administrator access required/,
  );
  roles = ["admin"];
  disabled = true;
  await assert.rejects(
    guard.canActivate(context(actor)),
    /administrator access required/,
  );
  disabled = false;
  assert.equal(await guard.canActivate(context(actor)), true);
  await assert.rejects(guard.canActivate(context()), /sign-in required/);
});

test("pagination and date ranges reject invalid and oversized inputs", async () => {
  assert.equal(pageSize(), 25);
  assert.equal(pageSize("100"), 100);
  for (const value of ["0", "101", "-5", "2.5", "no"])
    assert.throws(() => pageSize(value));
  const service = new UserManagementService(
    {} as FirebaseAdminService,
    {} as SecurityEventsService,
  );
  assert.throws(() => service.summary("999"));
  await assert.rejects(service.list({ cursor: "../users" }), /Invalid cursor/);
  await assert.rejects(
    service.list({ search: ["a"] as unknown as string }),
    /Invalid email search/,
  );
});

test("role edits preserve independent product permissions", () => {
  assert.deepEqual(
    managedRoles(
      ["user", "Admin", "shopyethu-seller", "cloudence-pro"],
      "moderator",
    ),
    ["shopyethu-seller", "cloudence-pro", "moderator"],
  );
});

test("user pages join only the requested profiles to Auth and return a stable cursor", async () => {
  const docs = ["a@example.test", "b@example.test", "c@example.test"].map(
    (id) => ({
      id,
      data: () => ({
        fullname: id,
        roles: ["user"],
        countryCode: 'ZA',
        gender: id === 'a@example.test' ? ' Non-binary ' : null,
        apps: { cloudence: { enabled: true, lastSeenAt: '2026-11-22T10:00:00Z' } },
        privateValue: "must not be returned",
      }),
    }),
  );
  let maximum = 0;
  let countCalls = 0;
  let after = "";
  const query = {
    orderBy: () => query,
    startAfter: (value: string) => {
      after = value;
      return query;
    },
    limit: (value: number) => {
      maximum = value;
      return query;
    },
    count: () => {
      countCalls++;
      return { get: async () => ({ data: () => ({ count: docs.length }) }) };
    },
    get: async () => ({
      docs: docs.filter((doc) => doc.id > after).slice(0, maximum),
    }),
  };
  const authLookups: string[][] = [];
  const firebase = {
    db: () => ({ collection: () => query }),
    auth: () => ({
      getUsers: async (keys: { email: string }[]) => {
        authLookups.push(keys.map((key) => key.email));
        return {
          users: keys
            .filter((key) => key.email !== "c@example.test")
            .map((key) => ({
              email: key.email,
              uid: key.email,
              emailVerified: true,
              disabled: key.email === "b@example.test",
              metadata: {},
            })),
        };
      },
    }),
  } as unknown as FirebaseAdminService;
  const service = new UserManagementService(
    firebase,
    {} as SecurityEventsService,
  );
  const first = await service.list({ limit: "2" });
  assert.equal(first.total, 3);
  assert.equal(first.nextCursor, "b@example.test");
  assert.equal(countCalls, 1);
  assert.deepEqual(
    first.users.map((user) => user.status),
    ["Active", "Suspended"],
  );
  assert.equal("privateValue" in first.users[0], false);
  assert.equal(first.users[0].gender, 'Non-binary');
  assert.equal(first.users[1].gender, null);
  assert.deepEqual(first.users[0].country, { code: 'ZA', name: 'South Africa', source: 'profile' });
  assert.equal(first.users[0].apps[0].name, 'Cloudence');
  assert.equal(first.users[0].apps[0].lastSeenAt, '2026-11-22T10:00:00.000Z');
  assert.equal(maximum, 3, "only one extra cursor sentinel is read");
  assert.deepEqual(authLookups[0], ["a@example.test", "b@example.test"]);
  const second = await service.list({ limit: "2", cursor: first.nextCursor! });
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, null);
  assert.equal(countCalls, 1);
  assert.equal(second.users[0].status, "Unavailable");
  assert.equal(second.users[0].uid, null);
});

test("mutation validation rejects string flags and arbitrary roles", async () => {
  assert.equal(
    (
      await validate(
        Object.assign(new UpdateManagedUserDto(), { disabled: null }),
      )
    ).length,
    1,
  );
  assert.equal(
    (await validate(Object.assign(new UpdateManagedUserDto(), { role: null })))
      .length,
    1,
  );
  assert.equal(
    (
      await validate(
        Object.assign(new UpdateManagedUserDto(), { disabled: "false" }),
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await validate(
        Object.assign(new UpdateManagedUserDto(), { role: "superuser" }),
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await validate(
        Object.assign(new UpdateManagedUserDto(), {
          disabled: false,
          role: "admin",
        }),
      )
    ).length,
    0,
  );
});

function mutationService(failRevoke = false) {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const profile = {
    get: async () => ({
      exists: true,
      data: () => ({ roles: ["user", "seller"] }),
    }),
  };
  const audit = {
    set: async (value: unknown) =>
      calls.push({ operation: "audit-start", value }),
    update: async (value: unknown) =>
      calls.push({ operation: "audit-end", value }),
  };
  const firebase = {
    auth: () => ({
      getUser: async () => ({ uid: "target", email: "target@example.test" }),
      updateUser: async (uid: string, change: unknown) =>
        calls.push({ operation: "auth-update", value: { uid, change } }),
      revokeRefreshTokens: async () => {
        if (failRevoke) throw new Error("revocation unavailable");
        calls.push({ operation: "revoke", value: "target" });
      },
    }),
    db: () => ({
      collection: (name: string) => ({
        doc: () => (name === "users" ? profile : audit),
      }),
      runTransaction: async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          get: profile.get,
          update: (_ref: unknown, value: unknown) =>
            calls.push({ operation: "roles", value }),
        }),
    }),
  } as unknown as FirebaseAdminService;
  const security = {
    publishSubjectRevocation: async (value: unknown) =>
      calls.push({ operation: "security-event", value }),
  } as unknown as SecurityEventsService;
  return { service: new UserManagementService(firebase, security), calls };
}

test("own access cannot be changed and empty changes have no side effects", async () => {
  const { service, calls } = mutationService();
  await assert.rejects(
    service.update(actor.uid, { disabled: true }, actor),
    /own access/,
  );
  await assert.rejects(
    service.update("target", {}, actor),
    /No account changes/,
  );
  assert.equal(calls.length, 0);
});

test("suspension persists in Firebase, revokes sessions, and writes a completed audit record", async () => {
  const { service, calls } = mutationService();
  assert.deepEqual(await service.update("target", { disabled: true }, actor), {
    ok: true,
  });
  assert.deepEqual(
    calls.map((call) => call.operation),
    ["audit-start", "auth-update", "revoke", "security-event", "audit-end"],
  );
  assert.deepEqual(calls[1].value, {
    uid: "target",
    change: { disabled: true },
  });
  assert.equal(
    (calls.at(-1)!.value as { outcome: string }).outcome,
    "completed",
  );
});

test("role changes preserve product roles and revoke existing sessions", async () => {
  const { service, calls } = mutationService();
  await service.update("target", { role: "moderator" }, actor);
  assert.deepEqual(
    (
      calls.find((call) => call.operation === "roles")!.value as {
        roles: string[];
      }
    ).roles,
    ["seller", "moderator"],
  );
  assert.ok(calls.some((call) => call.operation === "revoke"));
});

test("enabling never marks an email verified, and partial failures are audited as failures", async () => {
  const { service, calls } = mutationService();
  await service.update("target", { disabled: false }, actor);
  assert.deepEqual(
    calls.find((call) => call.operation === "auth-update")!.value,
    { uid: "target", change: { disabled: false } },
  );
  assert.ok(!calls.some((call) => call.operation === "revoke"));
  const failed = mutationService(true);
  await assert.rejects(
    failed.service.update("target", { disabled: true }, actor),
    /revocation unavailable/,
  );
  assert.equal(
    (failed.calls.at(-1)!.value as { outcome: string }).outcome,
    "failed",
  );
});

test("summary calculates real UTC intervals and uses aggregates without scanning profiles", async () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const day = 86_400_000;
  const records = [
    { createdAt: now - day, lastLoginAt: now - day, roles: ["admin"] },
    { createdAt: now - 6 * day, lastLoginAt: now - 40 * day, roles: ["user"] },
    { createdAt: now - 50 * day, lastLoginAt: now - day, roles: ["user"] },
  ];
  const query = (rows: typeof records): unknown => ({
    where: (
      field: keyof (typeof records)[number],
      op: string,
      value: { toMillis(): number } | string,
    ) =>
      query(
        rows.filter((row) => {
          const current = row[field];
          if (op === "array-contains")
            return Array.isArray(current) && current.includes(value as string);
          return op === ">="
            ? Number(current) >= (value as { toMillis(): number }).toMillis()
            : Number(current) < (value as { toMillis(): number }).toMillis();
        }),
      ),
    count: () => ({
      get: async () => ({ data: () => ({ count: rows.length }) }),
    }),
  });
  const db = { collection: () => query(records) } as unknown as Parameters<
    typeof userManagementSummary
  >[0];
  const summary = await userManagementSummary(db, 7, now);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 2);
  assert.equal(summary.newUsers, 2);
  assert.equal(summary.admins, 1);
  assert.equal(summary.growth.length, 7);
  assert.equal(
    summary.growth.reduce((sum, point) => sum + point.count, 0),
    2,
  );
});
