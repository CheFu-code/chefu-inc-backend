import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";

export type FirebaseDecodedToken = Awaited<
  ReturnType<ReturnType<FirebaseAdminService['auth']>['verifyIdToken']>
>;

export type AcademyProfileUpdate = {
  bio?: string;
  country?: string;
  countryCode?: string;
  language?: string;
  learningGoal?: string;
  skillLevel?: string;
  learningInterests?: string[];
  weeklyLearningGoal?: number;
  lessonStyle?: string;
  defaultCourseDifficulty?: string;
  preferredContentFormat?: string;
  aiTutorSuggestions?: boolean;
  privacy?: {
    publicProfile?: boolean;
    showCompletedCourses?: boolean;
    showCountry?: boolean;
    personalizedAiRecommendations?: boolean;
  };
  emailPreferences?: Record<string, boolean>;
};

export type ProfileUpdateBody = {
  fullname?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  bio?: string;
  website?: string;
  location?: string;
  profilePicture?: unknown;
  photoURL?: unknown;
  avatarUrl?: unknown;
  addressStreet?: string;
  addressCity?: string;
  addressPostalCode?: string;
  countryName?: string;
  countryCode?: string;
  storeName?: string;
  storeDescription?: string;
  emailPreferences?: {
    security?: boolean;
  };
  academyProfile?: AcademyProfileUpdate;
};

export type ProfilePictureUpdate = {
  shouldUpdate: boolean;
  value: string;
};

export type SignInAlertDecision = {
  reason: string;
  shouldSend: boolean;
  throttleMs: number;
};