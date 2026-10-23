# LiftWise backend

`LiftWiseModule` is registered in `AppModule`. All routes below require a verified CheFu OAuth bearer access token with `app=liftwise`. Ownership is derived from the token subject and never from request bodies.

| Route | Purpose |
| --- | --- |
| GET /liftwise/profile | Workout preferences |
| POST /liftwise/profile | Save onboarding preferences |
| POST /liftwise/support-reports | Submit an authenticated problem report |
| GET /liftwise/exercises?search= | Shared exercise catalogue |
| GET /liftwise/exercises/:id | Exercise details |
| GET /liftwise/exercises/:id/instructions | AI Coach with source instruction fallback |
| GET /liftwise/workouts?limit= | Own workouts |
| POST /liftwise/workouts | Create workout, optionally upload cover |
| GET /liftwise/workouts/:id | Own workout with exercise targets |
| POST /liftwise/workouts/:id/duplicate | Copy an owned workout with a new ID |
| DELETE /liftwise/workouts/:id | Remove an owned routine, preserving completed sessions |
| GET /liftwise/workout-sessions?limit= | Own completed workout history |
| POST /liftwise/workout-sessions | Save completed sets atomically |
| GET /liftwise/workout-sessions/:id | Own history details and volume |
| GET /liftwise/workout-sessions/calendar?start=&end= | Workout dates in a range |
| GET /liftwise/workout-sessions/streak | Dates used to compute streaks |
| GET /liftwise/home-stats?start=&end= | Daily workout count and duration |

Gender is shared account data at `users/{email}.gender`. Goal, experience, and weight unit live in the `profile` field of `users/{email}/appProfiles/liftwise`. The email comes from verified token claims and is normalized to lowercase. Saving onboarding atomically fills a missing shared gender and saves LiftWise preferences; existing shared answers and account/app metadata are preserved. Gender is not duplicated in the app profile. The profile endpoint combines the shared answer with app preferences. Shared auth profile responses include gender, and authenticated `PATCH /auth/profile` accepts explicit gender edits. OAuth `/oauth/userinfo` exposes current gender to apps with the `profile` scope, reading it fresh so an avatar cache cannot hide a newly supplied answer.

LiftWise signs users in before onboarding, loads their account profile, and asks only for missing answers. An account that already has gender skips that question; a completed LiftWise profile skips onboarding entirely. In-progress drafts are stored per authenticated user. Workouts and sessions remain in `liftwise_users/{uid}/workouts` and `liftwise_users/{uid}/sessions`, keyed by the verified token subject. Exercises live in `liftwise_exercises`, seeded transactionally from the existing 20-exercise catalogue on its first authenticated read. The included catalogue is sourced from https://github.com/yuhonas/free-exercise-db. Queries use single-field indexes; no additional composite indexes are needed.

Use the backend's existing Firebase Admin credentials, Cloudinary configuration for covers, and optional `GEMINI_API_KEY` for AI guidance. Image input is base64 JPEG/PNG/WebP capped at 2 MB. Session dates are ISO timestamps; stored times normalize to UTC, and ranges include the start and exclude the end. Optional list limits must be between 1 and 100.

LiftWise's client calls this backend using `EXPO_PUBLIC_API_BASE_URL`. It is a new app with no existing users or data to transfer, so it starts fresh in Firestore using CheFu user IDs directly. The frontend's PostgreSQL APIs, Neon and Drizzle dependencies, database schema, migrations, and database configuration have been removed. No account mapping or legacy-data migration is required. Deploy the matching CheFu Account redirect policies and OAuth client registrations before testing SSO.

Validation: `npm run typecheck`, `npm run build`, and `npm run test:liftwise`. Unit tests use isolated Firestore and OAuth adapters; end-to-end checks require live credentials and deployed apps.

Help & Support provides quick answers and a problem-report form. Reports are saved under `liftwise_users/{uid}/supportReports/{requestId}` with verified user ID/email, description (10–3000 trimmed characters), app version, platform, server timestamp, and `status: open`. The client retains a request ID for retries so a lost response does not duplicate a report. Reports can be reviewed in Firestore (including a `supportReports` collection-group query); no email notifications or support dashboard are configured by this feature.
