import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { LiftWiseService } from "./liftwise.service";
import { LiftWiseCatalogService } from "./liftwise-catalog.service";
import type { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import type { CloudinaryStorageService } from "../../common/cloudinary-storage.service";

test("Firestore emulator: concurrent completion retries atomically create one session and one activity entry", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  // This test can never connect to a production database or use production credentials.
  assert.match(process.env.FIRESTORE_EMULATOR_HOST!, /^(127\.0\.0\.1|localhost):\d+$/);
  const app = initializeApp({ projectId: "demo-liftwise" }, `test-${randomUUID()}`);
  const db = getFirestore(app);
  const firebase = { db: () => db } as FirebaseAdminService;
  const service = new LiftWiseService(firebase, new LiftWiseCatalogService(firebase), {} as CloudinaryStorageService);
  const uid = `emulator-${randomUUID()}`;
  const owner = db.collection("liftwise_users").doc(uid);
  try {
    await owner.collection("workouts").doc("workout").create({ id: "workout", name: "Test", image: null, exercises: [{ id: "squat", sets: 3 }], createdAt: "2026-10-24T10:00:00.000Z" });
    const input = { requestId: "completion", workoutId: "workout", startedAt: "2026-10-24T10:00:00.000Z", completedAt: "2026-10-24T10:10:00.000Z", durationSeconds: 600, sets: [{ exerciseId: "squat", setNumber: 1, reps: 10 }] };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.createSession(uid, input)));
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal((await owner.collection("sessions").get()).size, 1);
    const month = await owner.collection("liftwiseActivityMonths").doc("2026-10").get();
    assert.deepEqual(month.get("startedAt"), ["2026-10-24T10:00Z"]);
    await assert.rejects(service.createSession(uid, { ...input, durationSeconds: 601 }), /already been used/);
    assert.equal((await service.streak(uid)).workoutDates.length, 1);
  } finally {
    await db.recursiveDelete(owner);
    await db.terminate();
    await deleteApp(app);
  }
});
