# Quantum mobile SSO and Firestore

Quantum uses the existing `quantum-mobile` public OAuth client with the exact
`quantum://auth` callback. CheFu Account already permits that client and callback.
The `quantum-web` client retains `https://quantum.chefu.co.za/auth/callback`.
Native Quantum receives rotating refresh tokens with a 15-day absolute lifetime.
Other clients retain their existing refresh policy.

All mobile data routes are under `/quantum/agent` and use the existing `AuthGuard`.
The backend derives ownership from `request.user.uid`; request bodies cannot choose
another user. Existing `/quantum/conversations` endpoints remain available.

| Route | Methods | Purpose |
| --- | --- | --- |
| `/threads` | GET, POST | List/create the user's chat threads |
| `/threads/:id` | GET, DELETE | Read/delete a thread and its messages |
| `/threads/:id/messages` | GET, POST | Read/save messages |
| `/threads/:id/messages/:messageId` | PATCH | Update a message |
| `/tools` | GET | Catalog with the user's saved connection status |
| `/tools/:id/connect` | POST | Create a Composio authorization link |
| `/tools/:id/status` | GET | Reconcile connection status with Composio |
| `/tools/:id/disconnect` | POST | Revoke this user's matching accounts |
| `/schedules` | GET, POST | List/create schedules |
| `/schedules/:id` | PATCH | Pause/resume a schedule |
| `/schedules/:id/run` | POST | Run a schedule owned by this user |

Firestore collections:

- `quantum_agent_users/{chefuUid}/threads/{threadId}/messages/{messageId}`
- `quantum_agent_users/{chefuUid}/connections/{toolId}`
- `quantum_agent_tools/{toolId}` (optional catalog; an empty catalog uses built-in toolkit definitions)
- `quantum_agent_schedules/{taskId}/runs/{runId}`

Only the Admin SDK accesses these collections. Do not expose direct Firestore
client access. Deploy the `quantum_agent_schedules` composite index from
`firestore.indexes.json` through the project's normal index deployment process.
Quantum starts with empty user data; there is no import or legacy identity layer.

Configuration on the CheFu backend:

```dotenv
COMPOSIO_API_KEY=<same Composio project as the Quantum API host>
QUANTUM_AGENT_WORKER_URL=https://quantum.chefu.co.za/api/scheduled-run
QUANTUM_AGENT_WORKER_SECRET=<random secret of at least 32 characters>
```

Configure Composio auth configs in the Composio project. A catalog document's
`composio_auth_config_id` or `COMPOSIO_AUTH_CONFIG_<UPPERCASE_SLUG>` overrides
toolkit-based discovery. No user tokens or provider API keys belong in the app.

The Expo API host runs OpenAI/Composio/Browserbase execution and validates normal
chat requests against CheFu `/oauth/userinfo`. It accepts scheduler jobs only with
the shared server secret. Set the same secret on both hosts. Keep the worker on
HTTPS and allow requests lasting up to five minutes. Schedule creation/storage
works without a worker, but Run reports that execution is not configured.

The backend checks due schedules every minute when worker settings exist. A
Firestore transaction claims a ten-minute lease before execution, preventing
overlapping manual and automatic runs. Execution results are written into the
user's chat and schedule run history. A process crash after an external tool action
can still produce a repeated action after lease expiry; external side effects are
not exactly-once. Timezone calculations use the stored IANA timezone and skip
nonexistent daylight-saving times.

Validation: `npm run typecheck`, `npm run build`, `npm run test:quantum`, and
`npm run test:security`. Real browser SSO, Composio credentials, and Firestore
connectivity also need an installed mobile build and deployed services.
