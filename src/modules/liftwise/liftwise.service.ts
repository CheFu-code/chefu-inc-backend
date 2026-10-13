import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
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
  async profile(uid: string) {
    const snapshot = await this.owner(uid).get();
    return snapshot.exists ? (snapshot.data()?.profile ?? null) : null;
  }
  async saveProfile(uid: string, payload: unknown) {
    const body = validate.object(payload);
    if (
      !["male", "female"].includes(body.gender as string) ||
      !["build-muscle", "lose-fat", "maintain"].includes(body.goal as string) ||
      !["beginner", "intermediate", "advanced"].includes(
        body.experience as string,
      )
    )
      throw new BadRequestException("Invalid workout preferences.");
    const profile = {
      gender: body.gender,
      goal: body.goal,
      experience: body.experience,
      weightUnit: "kg",
    };
    await this.owner(uid).set(
      { profile, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    return { success: true };
  }
  exercises(search?: string) {
    return this.catalog.list(search);
  }
  exercise(exerciseId: string) {
    return this.catalog.get(exerciseId);
  }
  async instructions(exerciseId: string) {
    return this.catalog.instructions(exerciseId);
  }

  async workouts(uid: string, limitValue?: string) {
    let query = this.owner(uid)
      .collection("workouts")
      .orderBy("createdAt", "desc");
    const limit = validate.limit(limitValue);
    if (limit !== undefined) query = query.limit(limit);
    const snapshot = await query.get();
    return snapshot.docs.map((record) => {
      const workout = record.data() as Workout;
      return {
        id: record.id,
        name: workout.name,
        image: workout.image,
        muscles: workout.muscles,
        exerciseCount: workout.exercises.length,
        totalSets: workout.exercises.reduce(
          (sum, exercise) => sum + exercise.sets,
          0,
        ),
      };
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
      muscles: [...new Set(exercises.map((exercise) => exercise.muscles))].join(
        " • ",
      ),
      createdAt: new Date().toISOString(),
    };
    await this.owner(uid).collection("workouts").doc(workoutId).create(workout);
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
    const workoutId = validate.id(body.workoutId);
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
    const sessionId = randomUUID();
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
    // Store the session and all its sets in one atomic document write.
    await this.owner(uid).collection("sessions").doc(sessionId).create(session);
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
    let query = this.owner(uid)
      .collection("sessions")
      .orderBy("completedAt", "desc");
    const limit = validate.limit(limitValue);
    if (limit !== undefined) query = query.limit(limit);
    const snapshot = await query.get();
    return snapshot.docs.map((record) =>
      this.sessionSummary({
        ...record.data(),
        id: record.id,
      } as WorkoutSession),
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
    return {
      workoutDates: (await this.sessionsInRange(uid, start, end, 32)).map(
        (session) => session.startedAt,
      ),
    };
  }
  async streak(uid: string) {
    const snapshot = await this.owner(uid)
      .collection("sessions")
      .select("startedAt")
      .get();
    return {
      workoutDates: snapshot.docs.map(
        (record) => record.get("startedAt") as string,
      ),
    };
  }
}
