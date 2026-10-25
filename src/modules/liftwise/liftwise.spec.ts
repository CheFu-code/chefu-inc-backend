import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { LiftWiseAuthGuard } from "./liftwise-auth.guard";
import { LiftWiseService } from "./liftwise.service";
import { LiftWiseCatalogService } from "./liftwise-catalog.service";
import { DEFAULT_EXERCISES } from "./liftwise-exercises.data";
import { LiftWiseReadCache } from "./liftwise-read-cache";
import type { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { OAuthService } from "../auth/oauth.service";
import type { CloudinaryStorageService } from "../../common/cloudinary-storage.service";

// Isolated Firestore adapter: exercises the real service's paths, queries and writes.
function database() {
  const records = new Map<string, Record<string, unknown>>();
  const stats = {
    documentReads: 0,
    queryReads: 0,
    documentsRead: 0,
    writes: 0,
    aggregations: 0,
  };
  const snapshot = (key: string, fields?: string[]) => ({
    id: key.split("/").at(-1)!,
    exists: records.has(key),
    data: () => {
      const value = records.get(key);
      return value
        ? structuredClone(
            fields
              ? Object.fromEntries(
                  Object.entries(value).filter(([field]) =>
                    fields.includes(field),
                  ),
                )
              : value,
          )
        : undefined;
    },
    get: (field: string) => records.get(key)?.[field],
  });
  function set(key: string, value: Record<string, unknown>) {
    stats.writes++;
    const resolved = Object.fromEntries(
      Object.entries(value).map(([field, item]) => {
        const union = item as { elements?: unknown[] } | null;
        return [
          field,
          union && Array.isArray(union.elements)
            ? [
                ...new Set([
                  ...((records.get(key)?.[field] as unknown[]) ?? []),
                  ...union.elements,
                ]),
              ]
            : structuredClone(item),
        ];
      }),
    );
    records.set(key, { ...records.get(key), ...resolved });
  }
  function doc(key: string) {
    return {
      key,
      get: async () => {
        stats.documentReads++;
        stats.documentsRead++;
        return snapshot(key);
      },
      delete: async () => {
        stats.writes++;
        records.delete(key);
      },
      create: async (value: Record<string, unknown>) => {
        assert.equal(records.has(key), false);
        set(key, value);
      },
      set: async (value: Record<string, unknown>) => {
        set(key, value);
      },
      update: async (value: Record<string, unknown>) => {
        if (!records.has(key))
          throw Object.assign(new Error("Not found"), { code: 5 });
        set(key, value);
      },
      collection: (name: string) => collection(`${key}/${name}`),
    };
  }
  function collection(
    key: string,
    filters: ((value: Record<string, unknown>) => boolean)[] = [],
    sorting: { field: string; direction: string }[] = [],
    cap?: number,
    cursor?: string[],
    fields?: string[],
  ) {
    function keys() {
      let result = [...records.keys()].filter(
        (name) =>
          name.startsWith(`${key}/`) &&
          !name.slice(key.length + 1).includes("/") &&
          filters.every((filter) => filter(records.get(name)!)),
      );
      const values = (name: string) =>
        sorting.map(({ field }) =>
          field === "__name__"
            ? name.split("/").at(-1)!
            : String(records.get(name)![field]),
        );
      const compare = (left: string[], right: string[]) => {
        for (let i = 0; i < sorting.length; i++) {
          const value =
            left[i].localeCompare(right[i]) *
            (sorting[i].direction === "desc" ? -1 : 1);
          if (value) return value;
        }
        return 0;
      };
      if (sorting.length) result.sort((a, b) => compare(values(a), values(b)));
      if (cursor)
        result = result.filter((name) => compare(values(name), cursor) > 0);
      return cap === undefined ? result : result.slice(0, cap);
    }
    return {
      doc: (name: string) => doc(`${key}/${name}`),
      orderBy: (field: unknown, direction = "asc") =>
        collection(
          key,
          filters,
          [
            ...sorting,
            {
              field: typeof field === "string" ? field : "__name__",
              direction,
            },
          ],
          cap,
          cursor,
          fields,
        ),
      limit: (count: number) =>
        collection(key, filters, sorting, count, cursor, fields),
      startAfter: (...values: string[]) =>
        collection(key, filters, sorting, cap, values, fields),
      select: (...selected: string[]) =>
        collection(key, filters, sorting, cap, cursor, selected),
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
          cursor,
          fields,
        ),
      aggregate: () => ({
        get: async () => {
          stats.aggregations++;
          const found = keys();
          return {
            data: () => ({
              workouts: found.length,
              totalTimeSeconds: found.reduce(
                (sum, name) =>
                  sum + Number(records.get(name)?.durationSeconds ?? 0),
                0,
              ),
            }),
          };
        },
      }),
      get: async () => {
        stats.queryReads++;
        const found = keys();
        stats.documentsRead += Math.max(1, found.length);
        return {
          empty: found.length === 0,
          docs: found.map((name) => snapshot(name, fields)),
        };
      },
    };
  }
  const db = {
    collection,
    getAll: async (...refs: ReturnType<typeof doc>[]) => {
      stats.documentsRead += refs.length;
      stats.documentReads += refs.length;
      return refs.map((ref) => snapshot(ref.key));
    },
    batch: () => {
      const operations: (() => void)[] = [];
      return {
        create: (
          ref: ReturnType<typeof doc>,
          value: Record<string, unknown>,
        ) => {
          operations.push(() => {
            assert.equal(records.has(ref.key), false);
            set(ref.key, value);
          });
        },
        set: (ref: ReturnType<typeof doc>, value: Record<string, unknown>) => {
          operations.push(() => set(ref.key, value));
        },
        commit: async () => {
          operations.forEach((operation) => operation());
        },
      };
    },
    runTransaction: async (callback: (transaction: unknown) => Promise<void>) =>
      callback({
        getAll: async (...refs: ReturnType<typeof doc>[]) => {
          stats.documentReads += refs.length;
          stats.documentsRead += refs.length;
          return refs.map((ref) => snapshot(ref.key));
        },
        set: (ref: ReturnType<typeof doc>, value: Record<string, unknown>) =>
          set(ref.key, value),
        create: (ref: ReturnType<typeof doc>, value: Record<string, unknown>) =>
          set(ref.key, value),
      }),
  };
  return {
    firebase: { db: () => db } as unknown as FirebaseAdminService,
    records,
    stats,
  };
}
function setup() {
  const { firebase, records, stats } = database();
  const catalog = new LiftWiseCatalogService(firebase);
  const uploads: Record<string, unknown>[] = [];
  const storage = {
    uploadBuffer: async (_buffer: Buffer, options: Record<string, unknown>) => {
      uploads.push(options);
      return { secure_url: "https://images.example/cover.jpg" };
    },
  } as unknown as CloudinaryStorageService;
  return {
    service: new LiftWiseService(firebase, catalog, storage),
    catalog,
    records,
    uploads,
    stats,
  };
}

test("history pages are bounded, have stable timestamp ties, and compute totals without downloading all sessions", async () => {
  const { service, records, stats } = setup();
  for (let index = 0; index < 47; index++) {
    records.set(
      `liftwise_users/alice/sessions/session-${String(index).padStart(3, "0")}`,
      {
        completedAt: "2026-10-24T10:00:00.000Z",
        startedAt: "2026-10-24T09:00:00.000Z",
        workoutId: "workout",
        workoutName: "Workout",
        durationSeconds: 600,
        sets: [],
        image: null,
        exercises: [],
      },
    );
  }
  records.set("liftwise_users/bob/sessions/private", {
    completedAt: "2026-10-24T10:00:00.000Z",
    durationSeconds: 99,
    sets: [],
  });
  const first = await service.sessionPage("alice", "20");
  assert.equal(first.items.length, 20);
  assert.equal(stats.documentsRead, 21);
  assert.equal(stats.aggregations, 1);
  assert.deepEqual(first.summary, { workouts: 47, totalTimeSeconds: 47 * 600 });
  await service.sessionPage("alice", "20");
  assert.equal(
    stats.documentsRead,
    21,
    "the same page is served from the bounded cache",
  );
  const second = await service.sessionPage("alice", "20", first.nextCursor!);
  const third = await service.sessionPage("alice", "20", second.nextCursor!);
  assert.equal(third.nextCursor, null);
  assert.equal(stats.aggregations, 1, "later pages do not recalculate totals");
  const ids = [...first.items, ...second.items, ...third.items].map(
    (item) => item.id,
  );
  assert.equal(new Set(ids).size, 47);
  assert.equal(ids.includes("private"), false);
  const datePage = await service.sessionPage(
    "alice",
    "20",
    undefined,
    "2026-10-23T00:00:00Z",
    "2026-10-24T00:00:00Z",
  );
  assert.deepEqual(datePage.items, []);
  assert.equal(datePage.summary?.workouts, 0);
  await assert.rejects(service.sessionPage("alice", "101"));
  await assert.rejects(service.sessionPage("alice", "20", "invalid"));
  await assert.rejects(
    service.sessionPage(
      "alice",
      "20",
      undefined,
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
    ),
  );
});

test("preference patches read only the app profile and unchanged values produce no writes", async () => {
  const { service, records, stats } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  await service.saveProfile(user, {
    gender: "female",
    goal: "maintain",
    experience: "beginner",
    weightUnit: "kg",
  });
  const beforeReads = stats.documentReads;
  const beforeWrites = stats.writes;
  await service.patchProfile(user, { weightUnit: "lb" });
  assert.equal(stats.documentReads - beforeReads, 1);
  assert.equal(stats.writes - beforeWrites, 1);
  assert.equal(records.get("users/alice@example.com")?.gender, "female");
  await service.patchProfile(user, { weightUnit: "lb" });
  assert.equal(stats.writes - beforeWrites, 1);
  await service.patchProfile(user, {});
  assert.equal(stats.documentReads - beforeReads, 2);
  await assert.rejects(service.patchProfile(user, { gender: "male" }));
  await assert.rejects(
    service.patchProfile(user, {
      reminder: { enabled: true, hour: 24, minute: 0 },
    }),
  );
});

test("streak v2 backfill preserves activity dates; cold reads use bounded month summaries and new sessions update them atomically", async () => {
  const { firebase, records, stats } = database();
  const catalog = new LiftWiseCatalogService(firebase);
  const storage = {} as CloudinaryStorageService;
  const service = new LiftWiseService(firebase, catalog, storage);
  for (let index = 0; index < 90; index++) {
    records.set(`liftwise_users/alice/sessions/old-${index}`, {
      startedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    });
  }
  assert.equal((await service.streak("alice")).workoutDates.length, 90);
  const before = stats.documentsRead;
  const cold = new LiftWiseService(firebase, catalog, storage);
  assert.equal((await cold.streak("alice")).workoutDates.length, 90);
  assert.equal(
    stats.documentsRead - before,
    4,
    "only metadata and three month documents are read",
  );
  const workout = await cold.createWorkout("alice", workoutBody());
  const writes = stats.writes;
  await cold.createSession("alice", sessionBody(workout.id));
  assert.equal(
    stats.writes - writes,
    2,
    "session and month summary commit in the same batch",
  );
  assert.equal((await cold.streak("alice")).workoutDates.length, 91);
});

test("read cache coalesces requests, expires, retries failures, and invalidates only the changed resource and user", async () => {
  const cache = new LiftWiseReadCache();
  const key = JSON.stringify(["alice", "workouts"]);
  let loads = 0;
  const load = async () => ++loads;
  assert.deepEqual(
    await Promise.all([cache.get(key, load), cache.get(key, load)]),
    [1, 1],
  );
  cache.invalidateUser("bob");
  cache.invalidateUser("alice", ["bookmarks"]);
  assert.equal(await cache.get(key, load), 1);
  cache.invalidateUser("alice", ["workouts"]);
  assert.equal(await cache.get(key, load), 2);
  const clock = Date.now;
  try {
    Date.now = () => clock() + 60_000;
    assert.equal(await cache.get(key, load), 3);
  } finally {
    Date.now = clock;
  }
  const failing = JSON.stringify(["alice", "failure"]);
  await assert.rejects(
    cache.get(failing, async () => {
      throw new Error("Offline");
    }),
  );
  assert.equal(await cache.get(failing, async () => "recovered"), "recovered");
});
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

test("support reports use verified ownership, retain diagnostics, and retry without duplicates", async () => {
  const { service, records } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  const body = {
    requestId: "report-123",
    description: "  Workout fails to save after finishing.  ",
    appVersion: "1.0.0",
    platform: "android",
    userId: "bob",
    status: "closed",
    email: "bob@example.com",
  };
  const response = await service.submitSupportReport(user, body);
  assert.deepEqual(response, { id: "report-123", success: true });
  const report = records.get("liftwise_users/alice/supportReports/report-123")!;
  assert.equal(report.userId, "alice");
  assert.equal(report.email, "alice@example.com");
  assert.equal(report.status, "open");
  assert.equal(report.description, "Workout fails to save after finishing.");
  assert.equal(report.appVersion, "1.0.0");
  assert.equal(report.platform, "android");
  assert.ok(report.createdAt);
  await service.submitSupportReport(user, body);
  assert.equal(records.size, 1);
  await assert.rejects(
    service.submitSupportReport(user, {
      ...body,
      description: "A different problem happened.",
    }),
  );
  await service.submitSupportReport(
    { uid: "bob", email: "bob@example.com", roles: [] },
    body,
  );
  assert.equal(records.size, 2);
});

test("invalid support reports are rejected without storing data", async () => {
  const { service, records } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  const body = {
    requestId: "report-123",
    description: "Workout fails to save.",
    appVersion: "1.0.0",
    platform: "ios",
  };
  for (const change of [
    { description: "short" },
    { description: " ".repeat(20) },
    { description: "x".repeat(3001) },
    { platform: "unknown" },
    { appVersion: "x".repeat(41) },
    { requestId: "../bob" },
  ])
    await assert.rejects(
      service.submitSupportReport(user, { ...body, ...change }),
    );
  assert.equal(records.size, 0);
});

test("duplicating a workout preserves its details and stays within the owner account", async () => {
  const { service, records } = setup();
  const body = workoutBody();
  const source = await service.createWorkout("alice", {
    ...body,
    name: "x".repeat(80),
    description: "Original plan",
    exercises: [{ ...body.exercises[0], targetWeight: 50 }],
  });
  const original = {
    ...source,
    image: "https://images.example/shared-cover.jpg",
  };
  records.set(`liftwise_users/alice/workouts/${source.id}`, original);
  const copy = await service.duplicateWorkout("alice", source.id);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name.length, 80);
  assert.ok(copy.name.endsWith(" (copy)"));
  assert.deepEqual(copy.exercises, original.exercises);
  assert.equal(copy.description, original.description);
  assert.equal(copy.image, original.image);
  assert.ok(records.has(`liftwise_users/alice/workouts/${copy.id}`));
  assert.deepEqual(await service.workout("alice", source.id), original);
  await assert.rejects(service.duplicateWorkout("bob", source.id));
  await assert.rejects(service.duplicateWorkout("alice", "../other"));
});

test("deleting a workout preserves history and other users' data and supports retries", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const session = await service.createSession("alice", sessionBody(workout.id));
  const before = await service.session("alice", session.id);
  await service.deleteWorkout("bob", workout.id);
  assert.equal((await service.workout("alice", workout.id)).id, workout.id);
  await service.deleteWorkout("alice", workout.id);
  await assert.rejects(service.workout("alice", workout.id));
  assert.deepEqual(await service.session("alice", session.id), before);
  assert.deepEqual(await service.deleteWorkout("alice", workout.id), {
    success: true,
  });
  await assert.rejects(service.deleteWorkout("alice", "../other"));
});

test("exercise order persists without changing exercise targets or completed history", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", {
    ...workoutBody(),
    exercises: [
      {
        id: DEFAULT_EXERCISES[0].id,
        reps: 10,
        sets: 3,
        rest: 60,
        targetWeight: 40,
      },
      {
        id: DEFAULT_EXERCISES[1].id,
        reps: 8,
        sets: 4,
        rest: 90,
        targetWeight: 25,
      },
    ],
  });
  const session = await service.createSession("alice", sessionBody(workout.id));
  const history = await service.session("alice", session.id);
  const exerciseIds = workout.exercises
    .map((exercise) => exercise.id)
    .reverse();
  await service.reorderExercises("alice", workout.id, { exerciseIds });
  const result = await service.workout("alice", workout.id);
  assert.deepEqual(result, {
    ...workout,
    exercises: [...workout.exercises].reverse(),
  });
  assert.deepEqual(await service.session("alice", session.id), history);
  await service.reorderExercises("alice", workout.id, { exerciseIds });
  assert.deepEqual(await service.workout("alice", workout.id), result);
});

test("invalid orders and other users cannot modify a workout", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const first = workout.exercises[0].id;
  for (const exerciseIds of [
    [],
    [first, first],
    [DEFAULT_EXERCISES[1].id],
    ["../bad"],
    "bad",
    Array(11).fill(first),
  ]) {
    await assert.rejects(
      service.reorderExercises("alice", workout.id, { exerciseIds }),
    );
    assert.deepEqual(await service.workout("alice", workout.id), workout);
  }
  await assert.rejects(
    service.reorderExercises("bob", workout.id, { exerciseIds: [first] }),
  );
  await assert.rejects(
    service.reorderExercises("alice", "../bad", { exerciseIds: [first] }),
  );
  assert.deepEqual(await service.workout("alice", workout.id), workout);
});

test("changing a cover preserves workout details, copied covers, and historical images", async () => {
  const { service, records, uploads } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const original = { ...workout, image: "https://images.example/original.jpg" };
  records.set(`liftwise_users/alice/workouts/${workout.id}`, original);
  const copy = await service.duplicateWorkout("alice", workout.id);
  const session = await service.createSession("alice", sessionBody(workout.id));
  const image = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
  ]).toString("base64");
  const result = await service.changeWorkoutCover("alice", workout.id, {
    image,
  });
  assert.deepEqual(await service.workout("alice", workout.id), {
    ...original,
    image: result.image,
  });
  assert.equal((await service.workout("alice", copy.id)).image, original.image);
  assert.equal(
    (await service.session("alice", session.id)).image,
    original.image,
  );
  assert.equal(uploads[0].folder, "liftwise/alice");
  assert.ok(String(uploads[0].public_id).startsWith(`${workout.id}_`));
  await service.changeWorkoutCover("alice", workout.id, { image });
  assert.notEqual(uploads[0].public_id, uploads[1].public_id);
});

test("cover changes reject invalid images and unauthorized workouts before uploading", async () => {
  const { service, uploads } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  for (const image of [undefined, "", "bad", "x".repeat(2_800_001)])
    await assert.rejects(
      service.changeWorkoutCover("alice", workout.id, { image }),
    );
  const image = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
  ]).toString("base64");
  await assert.rejects(
    service.changeWorkoutCover("bob", workout.id, { image }),
  );
  await assert.rejects(
    service.changeWorkoutCover("alice", "../bad", { image }),
  );
  assert.equal(uploads.length, 0);
  assert.deepEqual(await service.workout("alice", workout.id), workout);
});

test("exercise bookmarks persist, support retries, and stay isolated by user", async () => {
  const { service } = setup();
  const id = DEFAULT_EXERCISES[0].id;
  assert.deepEqual(await service.bookmarks("alice"), []);
  await service.saveBookmark("alice", id);
  await service.saveBookmark("alice", id);
  assert.deepEqual(await service.bookmarks("alice"), [id]);
  assert.deepEqual(await service.bookmarks("bob"), []);
  await service.deleteBookmark("bob", id);
  assert.deepEqual(await service.bookmarks("alice"), [id]);
  await assert.rejects(service.saveBookmark("alice", "unknown-exercise"));
  await assert.rejects(service.deleteBookmark("alice", "../other"));
  await service.deleteBookmark("alice", id);
  await service.deleteBookmark("alice", id);
  assert.deepEqual(await service.bookmarks("alice"), []);
});

test("daily reminder settings validate time and survive other profile updates", async () => {
  const { service } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  const profile = {
    gender: "female",
    experience: "beginner",
    goal: "maintain",
  };
  const reminder = { enabled: true, hour: 18, minute: 30 };
  await service.saveProfile(user, { ...profile, reminder });
  await service.saveProfile(user, { ...profile, weightUnit: "lb" });
  assert.deepEqual((await service.profile(user))?.reminder, reminder);
  for (const change of [
    { hour: 24 },
    { minute: -1 },
    { minute: 0.5 },
    { enabled: "true" },
  ])
    await assert.rejects(
      service.saveProfile(user, {
        ...profile,
        reminder: { ...reminder, ...change },
      }),
    );
  assert.deepEqual((await service.profile(user))?.reminder, reminder);
});

test("session API rejects non-canonical weight units", async () => {
  const { service } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  await assert.rejects(
    service.createSession("alice", {
      ...sessionBody(workout.id),
      weightUnit: "lb",
    }),
  );
  const result = await service.createSession("alice", {
    ...sessionBody(workout.id),
    weightUnit: "kg",
  });
  assert.ok(result.id);
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

test("weight units persist, survive onboarding updates, and reject invalid values", async () => {
  const { service } = setup();
  const user = { uid: "alice", email: "alice@example.com", roles: [] };
  const profile = {
    gender: "female",
    goal: "maintain",
    experience: "beginner",
  };
  await service.saveProfile(user, { ...profile, weightUnit: "lb" });
  assert.equal((await service.profile(user))?.weightUnit, "lb");
  await service.saveProfile(user, profile);
  assert.equal((await service.profile(user))?.weightUnit, "lb");
  await assert.rejects(
    service.saveProfile(user, { ...profile, weightUnit: "oz" }),
  );
  assert.equal((await service.profile(user))?.weightUnit, "lb");
  await service.saveProfile(user, { ...profile, weightUnit: "kg" });
  assert.equal((await service.profile(user))?.weightUnit, "kg");
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

test("SSO userinfo returns fresh shared name, picture and gender with profile scope", async () => {
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
      name: "Old token name",
      scope,
    }),
  });
  records.set("users/alice@example.com", {
    gender: "female",
    fullname: "Current Name",
    profilePicture: "https://example.com/current.jpg",
  });
  assert.equal((await oauth.userinfo("Bearer token")).name, "Current Name");
  assert.equal(
    (await oauth.userinfo("Bearer token")).picture,
    "https://example.com/current.jpg",
  );
  assert.equal((await oauth.userinfo("Bearer token")).gender, "female");
  records.set("users/alice@example.com", {
    gender: "non-binary",
    fullname: "Updated Name",
    profilePicture: "https://example.com/updated.jpg",
  });
  assert.equal((await oauth.userinfo("Bearer token")).name, "Updated Name");
  assert.equal(
    (await oauth.userinfo("Bearer token")).picture,
    "https://example.com/updated.jpg",
  );
  assert.equal((await oauth.userinfo("Bearer token")).gender, "non-binary");
  scope = "openid email";
  assert.equal((await oauth.userinfo("Bearer token")).gender, undefined);
  assert.equal((await oauth.userinfo("Bearer token")).picture, undefined);
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
    { app: "quantum", typ: "access_token", sub: "alice" },
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

test("completion IDs make lost-response retries idempotent and reject payload reuse across operations", async () => {
  const { service, records, stats } = setup();
  const workout = await service.createWorkout("alice", workoutBody());
  const body = { ...sessionBody(workout.id), requestId: "stable-completion-id" };
  const before = stats.writes;
  const first = await service.createSession("alice", body);
  const retry = await service.createSession("alice", body);
  assert.deepEqual(retry, first);
  assert.equal(stats.writes - before, 2, "retry adds no session or summary write");
  await assert.rejects(service.createSession("alice", { ...body, durationSeconds: 601 }), /already been used/);
  assert.equal(stats.writes - before, 2);
  await assert.rejects(service.createSession("bob", body), /not found/);
  assert.equal(records.has("liftwise_users/bob/sessions/stable-completion-id"), false);
  await service.deleteWorkout("alice", workout.id);
  assert.deepEqual(await service.createSession("alice", body), first, "a confirmed completion can be retried even after its template is deleted");
});

test("workout pages bound reads, resolve timestamp ties and keep legacy list requests bounded", async () => {
  const { service, records, stats } = setup();
  for (let index = 0; index < 47; index++) records.set(`liftwise_users/alice/workouts/workout-${String(index).padStart(3,"0")}`, {name:"Workout",image:null,muscles:"back",exerciseCount:0,totalSets:0,exercises:[],createdAt:"2026-10-24T10:00:00.000Z"});
  assert.equal((await service.workouts("alice")).length,20);
  const before=stats.documentsRead;
  const first=await service.workoutPage("alice","20");
  assert.equal(stats.documentsRead-before,21);
  const second=await service.workoutPage("alice","20",first.nextCursor!);
  const third=await service.workoutPage("alice","20",second.nextCursor!);
  assert.equal(new Set([...first.items,...second.items,...third.items].map(item=>item.id)).size,47);
  assert.equal(third.nextCursor,null);
  await assert.rejects(service.workoutPage("alice","101"));
  await assert.rejects(service.workoutPage("alice","20","invalid"));
});

test("streak v2 backfill spans pages, preserves minute-offset local dates and does not grow for repeated sessions in one minute", async () => {
  const {service,records}=setup();
  const times=["2026-10-24T18:14:59.999Z","2026-10-24T18:15:00.001Z","2026-10-24T23:59:59.999Z"];
  for(let index=0;index<405;index++) records.set(`liftwise_users/alice/sessions/old-${String(index).padStart(3,"0")}`,{startedAt:times[index%times.length]});
  const result=await service.streak("alice");
  assert.equal(result.workoutDates.length,3);
  assert.equal(records.get("liftwise_users/alice/metadata/activity")?.streakVersion,2);
  for(const zone of ["Asia/Kathmandu","Pacific/Chatham","America/St_Johns","Africa/Johannesburg"]){
    const format=new Intl.DateTimeFormat("en-CA",{timeZone:zone});
    assert.deepEqual(new Set(result.workoutDates.map(value=>format.format(new Date(value)))),new Set(times.map(value=>format.format(new Date(value)))));
  }
  assert.equal([...records.keys()].filter(key=>key.includes("/sessions/")).length,405,"source history is untouched");
});

test("catalogue HTTP validators skip unchanged payloads and change with content",async()=>{
  const {LiftWiseController}=await import("./liftwise.controller");
  let records=[{id:"curl",name:"Curl"}];
  const controller=new LiftWiseController({exercises:async()=>records} as unknown as LiftWiseService);
  const headers:Record<string,string>={};let status=200;
  const response={setHeader:(key:string,value:string)=>{headers[key]=value;},vary:()=>{},status:(value:number)=>{status=value;}} as any;
  const request={headers:{}} as any;
  assert.deepEqual(await controller.exercises(request,response),records);
  request.headers["if-none-match"]=headers.ETag;
  assert.equal(await controller.exercises(request,response),undefined);
  assert.equal(status,304);
  records=[{id:"curl",name:"Updated Curl"}];status=200;
  assert.deepEqual(await controller.exercises(request,response),records);
  assert.equal(status,200);
});

test("AI guidance uses existing source content when its fresh-generation budget is exhausted and caches the fallback", async () => {
  const {firebase}=database();
  let calls=0;
  const limits={reserve:async()=>{calls++;return {limited:true};}};
  const catalog=new LiftWiseCatalogService(firebase,limits as any);
  const old=process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY="test-placeholder-never-sent";
  try{
    const exercise=(await catalog.all())[0];
    const first=await catalog.instructions(exercise.id,"alice");
    assert.deepEqual(first.instructions,exercise.instructions);
    assert.deepEqual(await catalog.instructions(exercise.id,"alice"),first);
    assert.equal(calls,1,"cached source guidance does not reserve another model request");
  }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
