import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { LiftWiseAuthGuard } from "./liftwise-auth.guard";
import { LiftWiseService } from "./liftwise.service";
import { LiftWiseCatalogService } from "./liftwise-catalog.service";
import { DEFAULT_EXERCISES } from "./liftwise-exercises.data";
import type { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { OAuthService } from "../auth/oauth.service";
import type { CloudinaryStorageService } from "../../common/cloudinary-storage.service";

// Isolated Firestore adapter: exercises the real service's paths, queries and writes.
function database() {
  const records = new Map<string, Record<string, unknown>>();
  const snapshot = (key: string) => ({
    id: key.split("/").at(-1)!,
    exists: records.has(key),
    data: () => structuredClone(records.get(key)),
    get: (field: string) => records.get(key)?.[field],
  });
  function doc(key: string) {
    return {
      key,
      get: async () => snapshot(key),
      create: async (value: Record<string, unknown>) => {
        assert.equal(records.has(key), false);
        records.set(key, structuredClone(value));
      },
      set: async (value: Record<string, unknown>) => {
        records.set(key, { ...records.get(key), ...structuredClone(value) });
      },
      collection: (name: string) => collection(`${key}/${name}`),
    };
  }
  function collection(
    key: string,
    filters: ((value: Record<string, unknown>) => boolean)[] = [],
    sorting?: { field: string; direction: string },
    cap?: number,
  ) {
    return {
      doc: (name: string) => doc(`${key}/${name}`),
      orderBy: (field: string, direction = "asc") =>
        collection(key, filters, { field, direction }, cap),
      limit: (count: number) => collection(key, filters, sorting, count),
      select: () => collection(key, filters, sorting, cap),
      where: (field: string, op: string, expected: string) =>
        collection(
          key,
          [
            ...filters,
            (value) =>
              op === ">="
                ? String(value[field]) >= expected
                : String(value[field]) < expected,
          ],
          sorting,
          cap,
        ),
      get: async () => {
        let keys = [...records.keys()].filter(
          (name) =>
            name.startsWith(`${key}/`) &&
            !name.slice(key.length + 1).includes("/") &&
            filters.every((filter) => filter(records.get(name)!)),
        );
        if (sorting)
          keys.sort(
            (a, b) =>
              String(records.get(a)![sorting.field]).localeCompare(
                String(records.get(b)![sorting.field]),
              ) * (sorting.direction === "desc" ? -1 : 1),
          );
        if (cap !== undefined) keys = keys.slice(0, cap);
        return { empty: keys.length === 0, docs: keys.map(snapshot) };
      },
    };
  }
  const db = {
    collection,
    runTransaction: async (callback: (transaction: unknown) => Promise<void>) =>
      callback({
        getAll: async (...refs: ReturnType<typeof doc>[]) =>
          refs.map((ref) => snapshot(ref.key)),
        set: (ref: ReturnType<typeof doc>, value: Record<string, unknown>) => {
          void ref.set(value);
        },
        create: (
          ref: ReturnType<typeof doc>,
          value: Record<string, unknown>,
        ) => {
          records.set(ref.key, structuredClone(value));
        },
      }),
  };
  return {
    firebase: { db: () => db } as unknown as FirebaseAdminService,
    records,
  };
}
function setup() {
  const { firebase, records } = database();
  const catalog = new LiftWiseCatalogService(firebase);
  const storage = {
    uploadBuffer: async () => ({
      secure_url: "https://images.example/cover.jpg",
    }),
  } as unknown as CloudinaryStorageService;
  return {
    service: new LiftWiseService(firebase, catalog, storage),
    catalog,
    records,
  };
}
const workoutBody = () => ({
  name: "Push day",
  exercises: [{ id: DEFAULT_EXERCISES[0].id, reps: 10, rest: 60, sets: 3 }],
});
const sessionBody = (workoutId: string) => ({
  workoutId,
  startedAt: "2026-10-13T10:00:00Z",
  completedAt: "2026-10-13T10:10:00Z",
  durationSeconds: 600,
  sets: [
    { exerciseId: DEFAULT_EXERCISES[0].id, setNumber: 1, reps: 10, weight: 20 },
  ],
});

test("catalogue seeds once into Firestore and search returns the existing exercises", async () => {
  const { catalog, records } = setup();
  assert.equal((await catalog.all()).length, 20);
  assert.equal(records.size, 20);
  assert.ok(
    (await catalog.list("bench")).every((exercise) =>
      exercise.name.toLowerCase().includes("bench"),
    ),
  );
  assert.equal((await catalog.all()).length, 20);
  assert.equal(records.size, 20);
});

test("workouts, sessions and profiles are isolated by verified user ID", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", {
    ...workoutBody(),
    userId: "bob",
  });
  assert.equal((await service.workouts("alice")).length, 1);
  assert.equal((await service.workouts("bob")).length, 0);
  await assert.rejects(service.workout("bob", workout.id), /not found/);
  const session = await service.createSession("alice", sessionBody(workout.id));
  await assert.rejects(service.session("bob", session.id), /not found/);
  await assert.rejects(
    service.createSession("bob", sessionBody(workout.id)),
    /not found/,
  );
  await service.saveProfile(
    { uid: "alice", email: "alice@example.com", roles: [] },
    {
      gender: "female",
      goal: "maintain",
      experience: "beginner",
    },
  );
  assert.equal(
    await service.profile({ uid: "bob", email: "bob@example.com", roles: [] }),
    null,
  );
});

test("onboarding preferences attach to the SSO account without overwriting shared fields", async () => {
  const { service, records } = setup();
  const accountPath = "users/alice@example.com";
  const profilePath = `${accountPath}/appProfiles/liftwise`;
  records.set(accountPath, {
    uid: "alice",
    fullname: "Alice",
    gender: "shared-value",
    roles: ["user"],
  });
  records.set(profilePath, {
    appId: "liftwise",
    enabled: true,
    createdAt: "existing-date",
  });
  const user = { uid: "alice", email: " Alice@Example.com ", roles: [] };
  const preferences = {
    gender: "female",
    goal: "build-muscle",
    experience: "beginner",
  };
  await service.saveProfile(user, {
    ...preferences,
    email: "bob@example.com",
    uid: "bob",
  });
  assert.deepEqual(await service.profile(user), {
    ...preferences,
    gender: "shared-value",
    weightUnit: "kg",
  });
  assert.deepEqual(records.get(accountPath), {
    uid: "alice",
    fullname: "Alice",
    gender: "shared-value",
    roles: ["user"],
  });
  assert.equal(records.get(profilePath)?.enabled, true);
  assert.equal(records.get(profilePath)?.createdAt, "existing-date");
  assert.equal(
    records.has("users/bob@example.com/appProfiles/liftwise"),
    false,
  );
  assert.equal(records.has("liftwise_users/alice"), false);
  assert.equal(
    (records.get(profilePath)?.profile as Record<string, unknown>).gender,
    undefined,
  );
});

test("gender is shared across apps while goal and experience remain app-specific", async () => {
  const { service, records } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  records.set("users/alice@example.com", { uid: "alice", fullname: "Alice" });
  assert.equal(await service.profile(user), null);
  await service.saveProfile(user, {
    gender: "female",
    goal: "maintain",
    experience: "beginner",
  });
  assert.equal(records.get("users/alice@example.com")?.gender, "female");
  assert.equal(records.get("users/alice@example.com")?.fullname, "Alice");
  const preferences = records.get(
    "users/alice@example.com/appProfiles/liftwise",
  )?.profile as Record<string, unknown>;
  assert.equal(preferences.gender, undefined);
  assert.equal(preferences.goal, "maintain");
  // Reuse another app's answer even when a stale draft submits something else.
  records.set("users/alice@example.com", {
    uid: "alice",
    gender: "non-binary",
  });
  await service.saveProfile(user, {
    gender: "male",
    goal: "build-muscle",
    experience: "advanced",
  });
  assert.equal(records.get("users/alice@example.com")?.gender, "non-binary");
  assert.equal((await service.profile(user))?.gender, "non-binary");
});

test("shared gender is returned even before this app has a profile", async () => {
  const { service, records } = setup();
  records.set("users/alice@example.com", { gender: "female" });
  assert.deepEqual(
    await service.profile({
      uid: "alice",
      email: "alice@example.com",
      roles: [],
    }),
    { gender: "female" },
  );
});

test("SSO userinfo exposes current shared gender only with profile scope", async () => {
  const { firebase, records } = database();
  const oauth = Object.create(OAuthService.prototype) as OAuthService;
  let scope = "openid profile email";
  Object.assign(oauth, {
    firebaseAdmin: firebase,
    verifyAccessToken: async () => ({
      typ: "access_token",
      sub: "alice",
      email: "alice@example.com",
      app: "liftwise",
      scope,
    }),
    getUserInfoProfile: async () => ({
      expiresAt: Date.now() + 30_000,
      picture: "https://example.com/avatar.jpg",
    }),
  });
  records.set("users/alice@example.com", { gender: "female" });
  assert.equal((await oauth.userinfo("Bearer token")).gender, "female");
  records.set("users/alice@example.com", { gender: "non-binary" });
  assert.equal((await oauth.userinfo("Bearer token")).gender, "non-binary");
  scope = "openid email";
  assert.equal((await oauth.userinfo("Bearer token")).gender, undefined);
});

test("profile access requires an authenticated email and rejects document paths", async () => {
  const { service } = setup();
  for (const email of ["", "../alice@example.com"]) {
    const user = { uid: "alice", email, roles: [] };
    await assert.rejects(service.profile(user), /authenticated account email/);
    await assert.rejects(
      service.saveProfile(user, {
        gender: "female",
        goal: "maintain",
        experience: "beginner",
      }),
      /authenticated account email/,
    );
  }
});

test("history, volume, daily stats and calendar preserve the app response shapes", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const created = await service.createSession("alice", sessionBody(workout.id));
  const detail = await service.session("alice", created.id);
  assert.equal(detail.volume, 200);
  assert.equal(detail.setCount, 1);
  assert.deepEqual(detail.exercises[0].sets, [{ reps: 10, weight: 20 }]);
  assert.deepEqual(
    await service.stats(
      "alice",
      "2026-10-13T00:00:00Z",
      "2026-10-14T00:00:00Z",
    ),
    { workouts: 1, totalTimeSeconds: 600, avgTimeSeconds: 600 },
  );
  assert.equal(
    (
      await service.calendar(
        "alice",
        "2026-10-13T10:00:00Z",
        "2026-10-14T00:00:00Z",
      )
    ).workoutDates.length,
    1,
  );
  assert.equal(
    (
      await service.calendar(
        "alice",
        "2026-10-12T10:00:00Z",
        "2026-10-13T10:00:00Z",
      )
    ).workoutDates.length,
    0,
  );
  assert.equal((await service.streak("alice")).workoutDates.length, 1);
});

test("duplicate, unrelated, excessive and invalid completed sets are rejected without writes", async () => {
  const { service, records } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const body = sessionBody(workout.id);
  for (const sets of [
    [body.sets[0], body.sets[0]],
    [{ ...body.sets[0], exerciseId: "other" }],
    [{ ...body.sets[0], setNumber: 4 }],
    [{ ...body.sets[0], weight: -1 }],
  ]) {
    await assert.rejects(service.createSession("alice", { ...body, sets }));
  }
  assert.equal(
    [...records.keys()].filter((key) => key.includes("/sessions/")).length,
    0,
  );
});

test("invalid workout inputs, ID paths, limits, images and date ranges are rejected", async () => {
  const { service } = setup();
  await assert.rejects(
    service.createWorkout("alice", { ...workoutBody(), exercises: [] }),
  );
  await assert.rejects(
    service.createWorkout("alice", {
      ...workoutBody(),
      image: Buffer.from("not an image").toString("base64"),
    }),
  );
  await assert.rejects(service.workout("alice", "../bob"));
  await assert.rejects(service.workouts("alice", "NaN"));
  await assert.rejects(
    service.stats("alice", "2026-10-13T00:00:00Z", "2026-11-13T00:00:00Z"),
  );
});

test("guard rejects absent credentials and tokens for another app or token type", async () => {
  for (const claims of [
    null,
    { app: "nook", typ: "access_token", sub: "alice" },
    { app: "liftwise", typ: "id_token", sub: "alice" },
  ]) {
    const request = {
      headers: { authorization: claims ? "Bearer token" : "" },
    };
    const guard = new LiftWiseAuthGuard({
      verifyAccessToken: async () => claims,
    } as unknown as OAuthService);
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await assert.rejects(guard.canActivate(context));
  }
});

test("guard derives user identity from verified token claims", async () => {
  const request: {
    headers: { authorization: string };
    user?: { uid: string };
  } = { headers: { authorization: "Bearer token" } };
  const guard = new LiftWiseAuthGuard({
    verifyAccessToken: async () => ({
      app: "liftwise",
      typ: "access_token",
      sub: "alice",
      email: "alice@example.com",
      roles: [],
    }),
  } as unknown as OAuthService);
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.user?.uid, "alice");
});
