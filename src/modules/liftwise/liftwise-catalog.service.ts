import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { DEFAULT_EXERCISES } from "./liftwise-exercises.data";
import type { LiftWiseExercise } from "./liftwise.types";
import { id, text } from "./liftwise.validation";

@Injectable()
export class LiftWiseCatalogService {
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebase: FirebaseAdminService,
  ) {}
  private cache: { until: number; records: LiftWiseExercise[] } | null = null;
  private loading: Promise<LiftWiseExercise[]> | null = null;
  private readonly logger = new Logger(LiftWiseCatalogService.name);
  private readonly guidance = new Map<
    string,
    Promise<{ instructions: string[] }>
  >();

  async all(): Promise<LiftWiseExercise[]> {
    if (this.cache && this.cache.until > Date.now()) return this.cache.records;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const collection = this.firebase.db().collection("liftwise_exercises");
      let snapshot = await collection.get();
      if (snapshot.empty) {
        // Seed only missing records, atomically, so concurrent startup cannot replace edits.
        await this.firebase.db().runTransaction(async (transaction) => {
          const refs = DEFAULT_EXERCISES.map((exercise) =>
            collection.doc(exercise.id),
          );
          const existing = await transaction.getAll(...refs);
          existing.forEach((record, index) => {
            if (!record.exists)
              transaction.create(refs[index], DEFAULT_EXERCISES[index]);
          });
        });
        snapshot = await collection.get();
      }
      const records = snapshot.docs.map(
        (record) => ({ ...record.data(), id: record.id }) as LiftWiseExercise,
      );
      this.cache = { until: Date.now() + 15 * 60_000, records };
      return records;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async list(search?: string) {
    const term = text(search, "search", 100, true).toLowerCase();
    return (await this.all())
      .filter(
        (exercise) =>
          !term ||
          `${exercise.name} ${exercise.muscles}`.toLowerCase().includes(term),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(exerciseId: string) {
    const key = id(exerciseId);
    const exercise = (await this.all()).find((record) => record.id === key);
    if (!exercise) throw new NotFoundException("Exercise not found.");
    return exercise;
  }

  async instructions(exerciseId: string) {
    const exercise = await this.get(exerciseId);
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) return { instructions: exercise.instructions || [] };
    const existing = this.guidance.get(exercise.id);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const response = await new GoogleGenAI({
          apiKey,
        }).models.generateContent({
          model: process.env.GEMINI_GENERATE_MODEL || "gemini-2.5-flash",
          config: { responseMimeType: "application/json" },
          contents: `Return JSON with an instructions array containing 4–5 concise steps for performing this exercise with proper form. Exercise: ${exercise.name}. Description: ${exercise.description}. Source guidance: ${JSON.stringify(exercise.instructions)}`,
        });
        const parsed: unknown = JSON.parse(response.text || "{}");
        const instructions = (parsed as { instructions?: unknown })
          ?.instructions;
        if (
          Array.isArray(instructions) &&
          instructions.length > 0 &&
          instructions.length <= 10 &&
          instructions.every(
            (step) =>
              typeof step === "string" &&
              step.length > 0 &&
              step.length <= 2000,
          )
        )
          return { instructions: instructions as string[] };
      } catch {
        this.logger.warn(
          "LiftWise AI guidance unavailable; using catalogue instructions.",
        );
      }
      this.guidance.delete(exercise.id);
      return { instructions: exercise.instructions || [] };
    })();
    this.guidance.set(exercise.id, pending);
    return pending;
  }
}
