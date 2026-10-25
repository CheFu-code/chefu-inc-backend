import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AggregateField,
  FieldPath,
  FieldValue,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { LiftWiseReadCache } from "./liftwise-read-cache";
import { decodeCursor, encodeCursor } from "./liftwise.pagination";
import type { AuthenticatedUser } from "../auth/authenticated-user";
import { sharedGender } from "../auth/shared-profile";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { CloudinaryStorageService } from "../../common/cloudinary-storage.service";
import { LiftWiseCatalogService } from "./liftwise-catalog.service";
import type {
  Workout,
  WorkoutExercise,
  WorkoutSession,
  SessionSet,
} from "./liftwise.types";
import * as validate from "./liftwise.validation";

@Injectable()
export class LiftWiseService {
  private readonly reads = new LiftWiseReadCache();
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebase: FirebaseAdminService,
    @Inject(LiftWiseCatalogService)
    private readonly catalog: LiftWiseCatalogService,
    @Inject(CloudinaryStorageService)
    private readonly storage: CloudinaryStorageService,
  ) {}

  private owner(uid: string) {
    if (
      typeof uid !== "string" ||
      !uid ||
      uid.length > 128 ||
      uid.includes("/") ||
      uid === "." ||
      uid === ".."
    )
      throw new BadRequestException("Invalid user ID.");
    return this.firebase.db().collection("liftwise_users").doc(uid);
  }
  private account(user: AuthenticatedUser) {
    const email = user.email?.trim().toLowerCase();
    if (!email || email.includes("/"))
      throw new UnauthorizedException(
        "An authenticated account email is required.",
      );
    return this.firebase.db().collection("users").doc(email);
  }
  async profile(user: AuthenticatedUser) {
    const account = this.account(user);
    const [shared, app] = await Promise.all([
      account.get(),
      account.collection("appProfiles").doc("liftwise").get(),
    ]);
    const { gender: legacyGender, ...preferences } = app.data()?.profile ?? {};
    const gender = sharedGender(shared.data()?.gender);
    return app.exists || gender
      ? { ...preferences, ...(gender ? { gender } : {}) }
      : null;
  }
  async saveProfile(user: AuthenticatedUser, payload: unknown) {
    const body = validate.object(payload);
    if (
      body.weightUnit !== undefined &&
      !["kg", "lb"].includes(body.weightUnit as string)
    )
      throw new BadRequestException("Invalid weight unit.");
    let reminder:
      { enabled: boolean; hour: number; minute: number } | undefined;
    if (body.reminder !== undefined) {
      const value = validate.object(body.reminder);
      if (typeof value.enabled !== "boolean")
        throw new BadRequestException("Invalid reminder setting.");
      reminder = {
        enabled: value.enabled,
        hour: validate.number(value.hour, "reminder hour", 0, 23),
        minute: validate.number(value.minute, "reminder minute", 0, 59),
      };
    }
    if (
      !["build-muscle", "lose-fat", "maintain"].includes(body.goal as string) ||
      !["beginner", "intermediate", "advanced"].includes(
        body.experience as string,
      )
    )
      throw new BadRequestException("Invalid workout preferences.");
    const account = this.account(user);
    const app = account.collection("appProfiles").doc("liftwise");
    await this.firebase.db().runTransaction(async (transaction) => {
      const [shared, existingApp] = await transaction.getAll(account, app);
      const knownGender = sharedGender(shared.data()?.gender);
      if (!knownGender && !["male", "female"].includes(body.gender as string))
        throw new BadRequestException("Please choose your gender.");
      // A stale app draft must never overwrite an answer already held by SSO.
      if (!knownGender)
        transaction.set(
          account,
          { gender: body.gender, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      const { gender: legacyGender, ...preferences } =
        existingApp.data()?.profile ?? {};
      const profile = {
        ...preferences,
        goal: body.goal,
        experience: body.experience,
        weightUnit: body.weightUnit ?? preferences.weightUnit ?? "kg",
        ...(reminder ? { reminder } : {}),
      };
      if (isDeepStrictEqual(existingApp.data()?.profile, profile)) return;
      transaction.set(
        app,
        { appId: "liftwise", profile, updatedAt: FieldValue.serverTimestamp() },
        { mergeFields: ["appId", "profile", "updatedAt"] },
      );
    });
    return { success: true };
  }
  async patchProfile(user: AuthenticatedUser, payload: unknown) {
    const body = validate.object(payload);
    const allowed = ["goal", "experience", "weightUnit", "reminder"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new BadRequestException("Invalid preference field.");
    if (
      body.goal !== undefined &&
      !["build-muscle", "lose-fat", "maintain"].includes(body.goal as string)
    )
      throw new BadRequestException("Invalid goal.");
    if (
      body.experience !== undefined &&
      !["beginner", "intermediate", "advanced"].includes(
        body.experience as string,
      )
    )
      throw new BadRequestException("Invalid experience.");
    if (
      body.weightUnit !== undefined &&
      !["kg", "lb"].includes(body.weightUnit as string)
    )
      throw new BadRequestException("Invalid weight unit.");
    if (body.reminder !== undefined) {
      const reminder = validate.object(body.reminder);
      if (typeof reminder.enabled !== "boolean")
        throw new BadRequestException("Invalid reminder setting.");
      body.reminder = {
        enabled: reminder.enabled,
        hour: validate.number(reminder.hour, "reminder hour", 0, 23),
        minute: validate.number(reminder.minute, "reminder minute", 0, 59),
      };
    }
    if (!Object.keys(body).length) return { success: true };
    const app = this.account(user).collection("appProfiles").doc("liftwise");
    await this.firebase.db().runTransaction(async (transaction) => {
      const [snapshot] = await transaction.getAll(app);
      const existing = snapshot.data()?.profile;
      if (!existing?.goal || !existing?.experience)
        throw new BadRequestException("Complete onboarding first.");
      const changes = Object.fromEntries(
        Object.entries(body).filter(
          ([key, value]) => !isDeepStrictEqual(value, existing[key]),
        ),
      );
      if (!Object.keys(changes).length) return;
      const { gender: legacyGender, ...preferences } = existing;
      transaction.set(
        app,
        {
          profile: { ...preferences, ...changes },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { mergeFields: ["profile", "updatedAt"] },
      );
    });
    return { success: true };
  }
  async submitSupportReport(user: AuthenticatedUser, payload: unknown) {
    const body = validate.object(payload);
    const requestId = validate.id(body.requestId);
    const description = validate.text(
      body.description,
      "problem description",
      3000,
    );
    if (description.length < 10)
      throw new BadRequestException(
        "Please describe the problem in at least 10 characters.",
      );
    const appVersion = validate.text(body.appVersion, "app version", 40);
    if (!["android", "ios", "web"].includes(body.platform as string))
      throw new BadRequestException("Invalid platform.");
    const report = this.owner(user.uid)
      .collection("supportReports")
      .doc(requestId);
    await this.firebase.db().runTransaction(async (transaction) => {
      const [existing] = await transaction.getAll(report);
      if (existing.exists) {
        if (existing.data()?.description !== description)
          throw new BadRequestException(
            "Please submit the updated report with a new request ID.",
          );
        return;
      }
      transaction.create(report, {
        appId: "liftwise",
        userId: user.uid,
        email: user.email ?? null,
        description,
        appVersion,
        platform: body.platform,
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return { id: requestId, success: true };
  }
  exercises(search?: string) {
    return this.catalog.list(search);
  }
  exercise(exerciseId: string) {
    return this.catalog.get(exerciseId);
  }
  async instructions(exerciseId: string, uid?: string) {
    return this.catalog.instructions(exerciseId, uid);
  }

  async bookmarks(uid: string) {
    return this.reads.get(JSON.stringify([uid, "bookmarks"]), async () => {
      const snapshot = await this.owner(uid)
        .collection("exerciseBookmarks")
        .get();
      return snapshot.docs.map((doc) => doc.id);
    });
  }
  async saveBookmark(uid: string, exerciseId: string) {
    const exercise = await this.catalog.get(exerciseId);
    await this.owner(uid)
      .collection("exerciseBookmarks")
      .doc(exercise.id)
      .set(
        { exerciseId: exercise.id, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    this.reads.invalidateUser(uid, ["bookmarks"]);
    return { success: true };
  }
  async deleteBookmark(uid: string, exerciseId: string) {
    await this.owner(uid)
      .collection("exerciseBookmarks")
      .doc(validate.id(exerciseId))
      .delete();
    this.reads.invalidateUser(uid, ["bookmarks"]);
    return { success: true };
  }
  async workouts(uid: string, limitValue?: string) {
    const limit = validate.limit(limitValue) ?? 20;
    return this.reads.get(
      JSON.stringify([uid, "workouts", limit]),
      async () => {
        let query = this.owner(uid)
          .collection("workouts")
          .orderBy("createdAt", "desc")
          .select("name", "image", "muscles", "exerciseCount", "totalSets");
        if (limit !== undefined) query = query.limit(limit);
        const snapshot = await query.get();
        return this.workoutSummaries(uid, snapshot.docs);
      },
    );
  }
  async workoutPage(uid: string, limitValue?: string, cursorValue?: string) {
    const limit = validate.limit(limitValue) ?? 20;
    const cursor = decodeCursor(cursorValue);
    return this.reads.get(JSON.stringify([uid, "workouts", "page", limit, cursor]), async () => {
      let query = this.owner(uid).collection("workouts")
        .orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc")
        .select("name", "image", "muscles", "exerciseCount", "totalSets", "createdAt");
      if (cursor) query = query.startAfter(...cursor);
      const snapshot = await query.limit(limit + 1).get();
      const docs = snapshot.docs.slice(0, limit);
      return {
        items: await this.workoutSummaries(uid, docs),
        nextCursor: snapshot.docs.length > limit ? encodeCursor(docs.at(-1)!.get("createdAt"), docs.at(-1)!.id) : null,
      };
    });
  }
  private async workoutSummaries(uid: string, docs: QueryDocumentSnapshot[]) {
    const missing = docs.filter((doc) => typeof doc.get("exerciseCount") !== "number" || typeof doc.get("totalSets") !== "number");
    // Compatibility for older records: one bounded getAll RPC, rather than an
    // N+1 loop. Newly created templates need no exercise payload or extra read.
    const legacy = missing.length ? await this.firebase.db().getAll(...missing.map((doc) => this.owner(uid).collection("workouts").doc(doc.id))) : [];
    const old = new Map(legacy.map((doc) => [doc.id, doc.data() as Workout | undefined]));
    return docs.map((record) => {
      const workout = record.data() as Workout;
      const exercises = old.get(record.id)?.exercises ?? [];
      return { id: record.id, name: workout.name, image: workout.image, muscles: workout.muscles,
        exerciseCount: workout.exerciseCount ?? exercises.length,
        totalSets: workout.totalSets ?? exercises.reduce((sum, exercise) => sum + exercise.sets, 0) };
    });
  }
  async workout(uid: string, workoutId: string): Promise<Workout> {
    const snapshot = await this.owner(uid)
      .collection("workouts")
      .doc(validate.id(workoutId))
      .get();
    if (!snapshot.exists) throw new NotFoundException("Workout not found.");
    return { ...snapshot.data(), id: snapshot.id } as Workout;
  }
  async reorderExercises(uid: string, workoutId: string, payload: unknown) {
    const body = validate.object(payload);
    if (
      !Array.isArray(body.exerciseIds) ||
      body.exerciseIds.length < 1 ||
      body.exerciseIds.length > 10
    )
      throw new BadRequestException("Invalid exercise order.");
    const ids = body.exerciseIds.map(validate.id);
    const ref = this.owner(uid)
      .collection("workouts")
      .doc(validate.id(workoutId));
    await this.firebase.db().runTransaction(async (transaction) => {
      const [snapshot] = await transaction.getAll(ref);
      if (!snapshot.exists) throw new NotFoundException("Workout not found.");
      const workout = snapshot.data() as Workout;
      const exercises = new Map(
        workout.exercises.map((exercise) => [exercise.id, exercise]),
      );
      if (
        ids.length !== workout.exercises.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !exercises.has(id))
      )
        throw new BadRequestException(
          "The exercise list changed. Reload the workout and try again.",
        );
      if (ids.every((id, index) => id === workout.exercises[index].id)) return;
      transaction.set(
        ref,
        { exercises: ids.map((id) => exercises.get(id)!) },
        { merge: true },
      );
    });
    this.reads.invalidateUser(uid, ["workouts"]);
    return { success: true };
  }
  async changeWorkoutCover(uid: string, workoutId: string, payload: unknown) {
    const body = validate.object(payload);
    if (typeof body.image !== "string" || !body.image.trim())
      throw new BadRequestException("Please choose a cover image.");
    await this.workout(uid, workoutId);
    // A new asset keeps covers in completed sessions and copied routines intact.
    const image = await this.uploadCover(
      uid,
      `${workoutId}_${randomUUID()}`,
      body.image,
    );
    const ref = this.owner(uid).collection("workouts").doc(workoutId);
    // update() enforces existence without a second transaction read.
    try {
      await ref.update({ image });
    } catch (error) {
      if ((error as { code?: number }).code === 5)
        throw new NotFoundException("Workout not found.");
      throw error;
    }
    this.reads.invalidateUser(uid, ["workouts"]);
    return { image };
  }
  async duplicateWorkout(uid: string, workoutId: string): Promise<Workout> {
    const source = await this.workout(uid, workoutId);
    const copy: Workout = {
      ...source,
      exerciseCount: source.exercises.length,
      totalSets: source.exercises.reduce((sum, exercise) => sum + exercise.sets, 0),
      id: randomUUID(),
      name: `${source.name.slice(0, 73)} (copy)`,
      createdAt: new Date().toISOString(),
    };
    await this.owner(uid).collection("workouts").doc(copy.id).create(copy);
    this.reads.invalidateUser(uid, ["workouts"]);
    return copy;
  }
  async deleteWorkout(uid: string, workoutId: string) {
    // Sessions keep their own workout snapshot; shared cover URLs remain valid.
    await this.owner(uid)
      .collection("workouts")
      .doc(validate.id(workoutId))
      .delete();
    this.reads.invalidateUser(uid, ["workouts"]);
    return { success: true };
  }
  async createWorkout(uid: string, payload: unknown) {
    const body = validate.object(payload);
    const name = validate.text(body.name, "workout name", 80);
    const description =
      validate.text(body.description, "description", 500, true) || null;
    if (
      !Array.isArray(body.exercises) ||
      body.exercises.length < 1 ||
      body.exercises.length > 10
    )
      throw new BadRequestException("Choose 1–10 exercises.");
    const selected = body.exercises.map((value) => {
      const exercise = validate.object(value);
      return {
        id: validate.id(exercise.id),
        reps: validate.number(exercise.reps, "reps", 1, 100),
        rest: validate.number(exercise.rest, "rest", 0, 600),
        sets: validate.number(exercise.sets, "sets", 1, 20),
        targetWeight:
          exercise.targetWeight === undefined
            ? null
            : validate.number(
                exercise.targetWeight,
                "target weight",
                0,
                1000,
                false,
              ),
      };
    });
    if (
      new Set(selected.map((exercise) => exercise.id)).size !== selected.length
    )
      throw new BadRequestException("Duplicate exercise.");
    const exercises: WorkoutExercise[] = await Promise.all(
      selected.map(async (exercise) => ({
        ...(await this.catalog.get(exercise.id)),
        ...exercise,
      })),
    );
    const workoutId = randomUUID();
    const image = await this.uploadCover(uid, workoutId, body.image);
    const workout: Workout = {
      id: workoutId,
      name,
      description,
      image,
      exercises,
      exerciseCount: exercises.length,
      totalSets: exercises.reduce((sum, exercise) => sum + exercise.sets, 0),
      muscles: [...new Set(exercises.map((exercise) => exercise.muscles))].join(
        " • ",
      ),
      createdAt: new Date().toISOString(),
    };
    await this.owner(uid).collection("workouts").doc(workoutId).create(workout);
    this.reads.invalidateUser(uid, ["workouts"]);
    return workout;
  }

  private async uploadCover(uid: string, workoutId: string, value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 2_800_000)
      throw new BadRequestException("Choose a cover image smaller than 2 MB.");
    const raw = value.replace(/^data:image\/(jpeg|png|webp);base64,/, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
      throw new BadRequestException("Invalid cover image.");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length > 2 * 1024 * 1024 || buffer.length < 12)
      throw new BadRequestException("Invalid cover image size.");
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      buffer.subarray(0, 4).toString() === "RIFF" &&
      buffer.subarray(8, 12).toString() === "WEBP";
    if (!jpeg && !png && !webp)
      throw new BadRequestException("Use a JPEG, PNG, or WebP image.");
    const uploaded = await this.storage.uploadBuffer(buffer, {
      resource_type: "image",
      folder: `liftwise/${validate.id(uid)}`,
      public_id: workoutId,
    });
    return uploaded.secure_url;
  }

  async createSession(uid: string, payload: unknown) {
    const body = validate.object(payload);
    const requestId = body.requestId === undefined ? randomUUID() : validate.id(body.requestId);
    const workoutId = validate.id(body.workoutId);
    if (body.weightUnit !== undefined && body.weightUnit !== "kg")
      throw new BadRequestException(
        "Session weights must be supplied in kilograms.",
      );
    const startedAt = validate.date(body.startedAt),
      completedAt = validate.date(body.completedAt);
    const durationSeconds = validate.number(
      body.durationSeconds,
      "duration",
      0,
      86_400,
    );
    if (
      completedAt < startedAt ||
      Date.parse(completedAt) - Date.parse(startedAt) > 86_400_000
    )
      throw new BadRequestException("Invalid session interval.");
    if (!Array.isArray(body.sets) || body.sets.length > 100)
      throw new BadRequestException("Invalid completed sets.");
    const sets: SessionSet[] = body.sets.map((value) => {
      const set = validate.object(value);
      return {
        exerciseId: validate.id(set.exerciseId),
        setNumber: validate.number(set.setNumber, "set number", 1, 20),
        reps: validate.number(set.reps, "reps", 0, 500),
        weight:
          set.weight === undefined
            ? null
            : validate.number(set.weight, "weight", 0, 1000, false),
      };
    });
    const keys = sets.map((set) => `${set.exerciseId}:${set.setNumber}`);
    if (new Set(keys).size !== keys.length)
      throw new BadRequestException("Duplicate completed set.");
    // Stable client identifiers make retries safe, including a lost HTTP response.
    const owner = this.owner(uid);
    const sessionRef = owner.collection("sessions").doc(requestId);
    const matches = (record: Record<string, unknown>) =>
      isDeepStrictEqual(
        [record.workoutId, record.startedAt, record.completedAt, record.durationSeconds, record.sets],
        [workoutId, startedAt, completedAt, durationSeconds, sets],
      );
    const previous = await sessionRef.get();
    if (previous.exists) {
      if (!matches(previous.data()!)) throw new ConflictException("This completion ID has already been used.");
      return { message: "Workout session created", id: requestId };
    }
    const workout = await this.workout(uid, workoutId);
    if (
      sets.some(
        (set) =>
          !workout.exercises.some(
            (exercise) =>
              exercise.id === set.exerciseId && set.setNumber <= exercise.sets,
          ),
      )
    )
      throw new BadRequestException(
        "Completed sets must belong to this workout.",
      );
    const sessionId = requestId;
    const session: WorkoutSession = {
      id: sessionId,
      workoutId,
      workoutName: workout.name,
      image: workout.image,
      startedAt,
      completedAt,
      durationSeconds,
      sets,
      exercises: workout.exercises,
    };
    // Minute precision preserves present-day IANA local calendar dates. Each month
    // has at most 44,640 unique entries, bounded independently of session count.
    const batch = this.firebase.db().batch();
    batch.create(owner.collection("sessions").doc(sessionId), session);
    batch.set(
      owner.collection("liftwiseActivityMonths").doc(startedAt.slice(0, 7)),
      { startedAt: FieldValue.arrayUnion(startedAt.slice(0, 16) + "Z") },
      { merge: true },
    );
    try {
      await batch.commit();
    } catch (error) {
      // Firestore create() and the activity update commit atomically. A competing
      // retry cannot write a second session or update derived data a second time.
      if ((error as { code?: number }).code !== 6) throw error;
      const existing = await sessionRef.get();
      if (!existing.exists || !matches(existing.data()!))
        throw new ConflictException("This completion ID has already been used.");
    }
    this.reads.invalidateUser(uid, [
      "sessions",
      "session-page",
      "calendar",
      "streak",
    ]);
    return { message: "Workout session created", id: sessionId };
  }
  private sessionSummary(session: WorkoutSession) {
    return {
      id: session.id,
      workoutId: session.workoutId,
      workoutName: session.workoutName,
      image: session.image,
      completedAt: session.completedAt,
      durationSeconds: session.durationSeconds,
      exerciseCount: new Set(session.sets.map((set) => set.exerciseId)).size,
      setCount: session.sets.length,
    };
  }
  async sessions(uid: string, limitValue?: string) {
    const limit = validate.limit(limitValue) ?? 20;
    return this.reads.get(
      JSON.stringify([uid, "sessions", limit]),
      async () => {
        let query = this.owner(uid)
          .collection("sessions")
          .orderBy("completedAt", "desc")
          .select(
            "workoutId",
            "workoutName",
            "image",
            "completedAt",
            "durationSeconds",
            "sets",
          )
          .limit(limit);
        const snapshot = await query.get();
        return snapshot.docs.map((record) =>
          this.sessionSummary({
            ...record.data(),
            id: record.id,
          } as WorkoutSession),
        );
      },
    );
  }
  async sessionPage(
    uid: string,
    limitValue?: string,
    cursorValue?: string,
    start?: string,
    end?: string,
  ) {
    const limit = validate.limit(limitValue) ?? 20;
    const cursor = decodeCursor(cursorValue);
    const interval =
      start !== undefined || end !== undefined
        ? validate.range(start, end, 1)
        : undefined;
    return this.reads.get(
      JSON.stringify([uid, "session-page", limit, cursor, interval]),
      async () => {
        const collection = this.owner(uid).collection("sessions");
        const summaryQuery = interval
          ? collection
              .where("completedAt", ">=", interval.start)
              .where("completedAt", "<", interval.end)
          : collection;
        let query = summaryQuery
          .orderBy("completedAt", "desc")
          .orderBy(FieldPath.documentId(), "desc");
        if (cursor) query = query.startAfter(cursor[0], cursor[1]);
        const [snapshot, summary] = await Promise.all([
          query
            .select(
              "workoutId",
              "workoutName",
              "image",
              "completedAt",
              "durationSeconds",
              "sets",
            )
            .limit(limit + 1)
            .get(),
          cursor
            ? Promise.resolve(undefined)
            : summaryQuery
                .aggregate({
                  workouts: AggregateField.count(),
                  totalTimeSeconds: AggregateField.sum("durationSeconds"),
                })
                .get(),
        ]);
        const records = snapshot.docs.slice(0, limit);
        const last = records.at(-1);
        return {
          items: records.map((record) =>
            this.sessionSummary({
              ...record.data(),
              id: record.id,
            } as WorkoutSession),
          ),
          nextCursor:
            snapshot.docs.length > limit && last
              ? encodeCursor(last.get("completedAt") as string, last.id)
              : null,
          ...(summary ? { summary: summary.data() } : {}),
        };
      },
    );
  }
  async session(uid: string, sessionId: string) {
    const snapshot = await this.owner(uid)
      .collection("sessions")
      .doc(validate.id(sessionId))
      .get();
    if (!snapshot.exists) throw new NotFoundException("Session not found.");
    const session = { ...snapshot.data(), id: snapshot.id } as WorkoutSession;
    const exercises = session.exercises
      .filter((exercise) =>
        session.sets.some((set) => set.exerciseId === exercise.id),
      )
      .map((exercise) => ({
        id: exercise.id,
        name: exercise.name,
        image: exercise.image,
        sets: session.sets
          .filter((set) => set.exerciseId === exercise.id)
          .sort((a, b) => a.setNumber - b.setNumber)
          .map((set) => ({ reps: set.reps, weight: set.weight })),
      }));
    const weighted = session.sets.filter((set) => set.weight !== null);
    return {
      ...this.sessionSummary(session),
      exercises,
      volume: weighted.length
        ? Math.round(
            weighted.reduce((sum, set) => sum + set.reps * set.weight!, 0),
          )
        : null,
    };
  }
  private async sessionsInRange(
    uid: string,
    start: string,
    end: string,
    maxDays: number,
  ) {
    const interval = validate.range(start, end, maxDays);
    const snapshot = await this.owner(uid)
      .collection("sessions")
      .where("startedAt", ">=", interval.start)
      .where("startedAt", "<", interval.end)
      .select("startedAt", "completedAt", "durationSeconds")
      .get();
    return snapshot.docs.map((record) => record.data() as WorkoutSession);
  }
  async stats(uid: string, start: string, end: string) {
    const sessions = await this.sessionsInRange(uid, start, end, 1);
    const totalTimeSeconds = sessions.reduce(
      (sum, session) => sum + session.durationSeconds,
      0,
    );
    return {
      workouts: sessions.length,
      totalTimeSeconds,
      avgTimeSeconds: sessions.length
        ? Math.round(totalTimeSeconds / sessions.length)
        : 0,
    };
  }
  async calendar(uid: string, start: string, end: string) {
    const interval = validate.range(start, end, 32);
    return this.reads.get(
      JSON.stringify([uid, "calendar", interval]),
      async () => {
        const sessions = await this.sessionsInRange(
          uid,
          interval.start,
          interval.end,
          32,
        );
        return {
          workoutDates: sessions.map((session) => session.startedAt),
          sessions: sessions.map(
            ({ startedAt, completedAt, durationSeconds }) => ({
              startedAt,
              completedAt,
              durationSeconds,
            }),
          ),
        };
      },
    );
  }
  async streak(uid: string) {
    return this.reads.get(
      JSON.stringify([uid, "streak"]),
      async () => {
        const owner = this.owner(uid);
        const metadata = owner.collection("metadata").doc("activity");
        const migration = (await metadata.get()).data();
        if (migration?.streakVersion !== 2) {
          // Versioned, resumable backfill. Source sessions and v1 summaries remain
          // intact. Each query and batch is bounded; retries only union entries.
          let cursor = migration?.streakV2Cursor as [string, string] | undefined;
          for (;;) {
            let query = owner.collection("sessions")
              .orderBy("startedAt", "asc").orderBy(FieldPath.documentId(), "asc")
              .select("startedAt").limit(200);
            if (cursor) query = query.startAfter(...cursor);
            const page = await query.get();
            const months = new Map<string, Set<string>>();
            for (const record of page.docs) {
              const startedAt = record.get("startedAt") as string;
              const month = startedAt.slice(0, 7);
              const values = months.get(month) ?? new Set<string>();
              values.add(startedAt.slice(0, 16) + "Z");
              months.set(month, values);
            }
            const batch = this.firebase.db().batch();
            for (const [month, dates] of months) batch.set(
              owner.collection("liftwiseActivityMonths").doc(month),
              { startedAt: FieldValue.arrayUnion(...dates) }, { merge: true },
            );
            const last = page.docs.at(-1);
            if (last) cursor = [last.get("startedAt"), last.id];
            const complete = page.docs.length < 200;
            batch.set(metadata, { ...(cursor ? { streakV2Cursor: cursor } : {}), ...(complete ? { streakVersion: 2 } : {}) }, { merge: true });
            await batch.commit();
            if (complete) break;
          }
        }
        const years = await owner
          .collection("liftwiseActivityMonths")
          .select("startedAt")
          .get();
        return {
          workoutDates: years.docs.flatMap(
            (record) => (record.get("startedAt") as string[]) ?? [],
          ),
        };
      },
      60_000,
    );
  }
}
