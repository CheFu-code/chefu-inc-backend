import "reflect-metadata";
import { FirebaseAdminService } from "../src/modules/firebase-admin/firebase-admin.service";
import { FieldPath } from "firebase-admin/firestore";

// Opt-in diagnostic only. Query Explain is not an emulator billing benchmark.
const uid = process.argv.find((arg) => arg.startsWith("--uid="))?.slice(6);
if (!process.argv.includes("--allow-live-plan") || !uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid))
  throw new Error("Specify --allow-live-plan --uid=<test-account-uid>. Use --analyze only when accepting execution charges.");
const analyze = process.argv.includes("--analyze");
const firebase = new FirebaseAdminService();
const db = firebase.db();
const owner = db.collection("liftwise_users").doc(uid);
try {
  const queries = [
    ["home-workouts", owner.collection("workouts").orderBy("createdAt", "desc").select("name", "image", "muscles", "exerciseCount", "totalSets").limit(4)],
    ["workout-page", owner.collection("workouts").orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(21)],
    ["history-page", owner.collection("sessions").orderBy("completedAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(21)],
  ] as const;
  for (const [scenario, query] of queries) {
    const { metrics } = await query.explain({ analyze });
    console.log(JSON.stringify({ scenario, analyze, metrics }));
  }
} finally { await db.terminate(); }
