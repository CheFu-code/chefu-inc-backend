export type LiftWiseExercise = {
  id: string;
  name: string;
  image: string | null;
  muscles: string;
  description: string;
  category: string;
  equipment: string | null;
  difficulty: string;
  forceType: string | null;
  mechanics: string | null;
  instructions: string[];
};
export type WorkoutExercise = LiftWiseExercise & {
  reps: number;
  rest: number;
  sets: number;
  targetWeight: number | null;
};
export type Workout = {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  muscles: string;
  exercises: WorkoutExercise[];
  createdAt: string;
};
export type SessionSet = {
  exerciseId: string;
  setNumber: number;
  reps: number;
  weight: number | null;
};
export type WorkoutSession = {
  id: string;
  workoutId: string;
  workoutName: string;
  image: string | null;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  exercises: WorkoutExercise[];
  sets: SessionSet[];
};
