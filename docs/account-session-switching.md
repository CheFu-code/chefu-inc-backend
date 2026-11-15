# Saved-account identity and switching

The chooser stores independent sign-in cookies in up to eight browser slots. It does not create a new user record when an account is selected.

The duplication bug occurred when the browser was signed into B with A saved in a slot, then a fresh password/passkey session was created for A. The old code preserved B but did not remove A's saved slot. The accounts endpoint returned both the active A and saved A without checking their verified Firebase UID. Switching could carry these duplicate slots forward.

The accounts endpoint now returns each verified UID once, with the active account first. It keeps the real saved slot numbers, so selecting an account still targets the correct cookie. Duplicate cookies share a request-local verification, and display lookups run only after deduplication. The list is read-only.

Successful session creation and switching reconcile the slots: remove saved copies of the new active UID, preserve one copy of the previous account, and remove verified duplicate copies of unrelated saved accounts. Removal deletes all verified saved copies of that account. Unrelated cookies that cannot currently be verified are retained rather than silently deleting a sign-in during an outage. Revoked or invalid targets still fail before any cookie mutation. No Firestore documents are written by this reconciliation.

The existing oversized session route class was split into account, session creation, password/passkey and remaining session route classes. Nest inherits the existing handlers and decorators; HTTP paths and response shapes are unchanged. Every new route/helper/test file remains below 500 lines.

Deploy the backend for the fix to take effect. Existing duplicates disappear from the list immediately after deployment; the next successful sign-in or switch reconciles duplicate cookies. No user database migration or global logout is needed.

Run `npm run test:account-sessions`. The regression covers the original password re-login sequence, twenty switches back and forth, legacy duplicates, mismatched display metadata, expired/revoked cookies, removing all saved copies, and inherited Nest route discovery. These are automated tests, not a claim of live browser verification.
