import type { LiftWiseExercise } from "./liftwise.types";

export type LiftWiseRecommendationProfile = {
  experience?: string;
  fitnessLevel?: string;
  trainingLocation?: string;
  limitations?: string;
};

const difficultyByLevel: Record<string, string[]> = {
  low: ["beginner", "intermediate", "advanced"],
  beginner: ["beginner", "intermediate", "advanced"],
  moderate: ["intermediate", "beginner", "advanced"],
  intermediate: ["intermediate", "beginner", "advanced"],
  high: ["advanced", "intermediate", "beginner"],
  advanced: ["advanced", "intermediate", "beginner"],
};

const limitationMovements: Record<string, string[]> = {
  ankle: ["squat", "lunge", "calf", "step-up"],
  back: ["deadlift", "good morning", "bent-over", "back extension"],
  hip: ["squat", "lunge", "deadlift", "hip thrust"],
  knee: ["squat", "lunge", "leg press", "leg extension", "step-up"],
  shoulder: ["overhead", "shoulder press", "lateral raise", "bench press", "push-up"],
  wrist: ["curl", "press", "push-up", "plank"],
};

function searchableExercise(exercise: LiftWiseExercise) {
  return [
    exercise.name,
    exercise.description,
    exercise.muscles,
    exercise.category,
    exercise.equipment,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isUnsafe(exercise: LiftWiseExercise, limitations?: string) {
  if (!limitations) return false;
  const text = limitations.toLowerCase();
  const searchable = searchableExercise(exercise);
  return Object.entries(limitationMovements).some(
    ([bodyPart, movements]) =>
      text.includes(bodyPart) && movements.some((movement) => searchable.includes(movement)),
  );
}

function scoreExercise(
  exercise: LiftWiseExercise,
  profile: LiftWiseRecommendationProfile,
) {
  let score = 0;
  const preferredDifficulty =
    difficultyByLevel[profile.fitnessLevel ?? ""] ??
    difficultyByLevel[profile.experience ?? ""] ??
    [];
  const difficultyIndex = preferredDifficulty.indexOf(exercise.difficulty.toLowerCase());
  if (difficultyIndex >= 0) score += 12 - difficultyIndex * 3;

  if (profile.trainingLocation === "home" && !exercise.equipment) score += 6;
  if (profile.trainingLocation === "gym" && exercise.equipment) score += 4;
  if (profile.trainingLocation === "mixed") score += 1;

  return score;
}

export function rankExercises(
  exercises: LiftWiseExercise[],
  profile: LiftWiseRecommendationProfile | null,
) {
  if (!profile) return [...exercises].sort((a, b) => a.name.localeCompare(b.name));

  return exercises
    .filter((exercise) => !isUnsafe(exercise, profile.limitations))
    .map((exercise, index) => ({
      exercise,
      index,
      score: scoreExercise(exercise, profile),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.exercise.name.localeCompare(b.exercise.name) ||
        a.index - b.index,
    )
    .map(({ exercise }) => exercise);
}
