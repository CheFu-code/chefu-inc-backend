Cloudence file content is delivered through `/cloudence/files/:id/content`.
The endpoint requires the user's session cookie or bearer token, reads current
ownership and recipient permissions, and streams content without exposing the
storage URL. Responses use `private, no-store`. Downloads, image previews, and
byte-range requests all require authorization. Revoking access stops subsequent
requests; it cannot erase bytes already downloaded by an authorized recipient.

Set `PUBLIC_API_BASE_URL` to the deployed API origin (default:
`https://api.chefu.co.za`). New uploads use Cloudinary's `authenticated` delivery
type. Existing `upload` assets fail closed until migrated. Do not restore the
old public-URL fallback or run protected images through Next's shared optimizer.
Web middleware rejects Cloudence source URLs on `/_next/image`, including old
public previews. Purge any previously cached file previews at the web hosting
CDN as part of deployment if that CDN can serve them before middleware runs.

Fly.io deployments automatically run `npm run release:prod` in the release
Machine using the application's production secrets. `npm run build` compiles
the migration to `dist-migrations`, so production execution does not require
`tsx` or a local `.env`. The hook invokes the migration with `--apply --once`:
it makes one automatic migration attempt on the next deployment before the new
backend Machines start. It does not run on ordinary server starts, restarts,
or requests, and subsequent deployments skip migration work.
Deploy the accompanying web changes as well.

For the first rollout, pause uploads from the previous backend version until
deployment completes: that version can still create public assets during a
rolling deployment. If public uploads occurred after the migration finished,
remove the `completedAt` field from
`systemMigrations/cloudence-private-storage-v1` and rerun the migration.

A successful full migration records its completion in that document. The
automatic run also records `automaticAttemptedAt` before changing assets.
Later deployments perform one marker read and skip all file scans and
Cloudinary calls, even if that attempt failed, timed out, or left pending CDN
revocation. Manual `--apply` runs ignore the automatic-attempt marker and can
resume unfinished work without repeating completed renames.
A renewable lease prevents simultaneous migrations. An interrupted run can
resume once its lease expires (at most 35 minutes since its last renewal).
Limited runs never mark the full migration complete. Do not restore an older
backend that writes public assets after migration completion.

Missing credentials or migration errors stop the deployment. Pending CDN
revocation (exit code 2) logs a warning and permits the new protected API to
deploy, without marking completion. Neither failures nor pending revocation
trigger another automatic attempt. Inspect the first deployment's logs and
run a manual retry if needed. The release command has a 30-minute timeout;
interrupted or large migrations must be resumed manually.

For a manual dry run or retry, use production Firebase and Cloudinary
environment configuration:

```
npm run migrate:cloudence-private
npm run migrate:cloudence-private -- --apply
```

The default command is a paginated dry run. `--limit=10` limits selected
documents. The applied migration includes soft-deleted files, persists its
target before renaming, requests CDN invalidation, and can be rerun after
interruption. It changes storage fields only; file IDs, bytes, quota, owners,
and recipient lists are preserved. All clients must use authenticated API
URLs; native mobile clients must supply their bearer token when loading images
or downloading files.

Old signed CDN URLs may remain cached despite `invalidate: true`. Cloudinary
documents that signed-URL invalidation is not enabled by default. Enable it
through Cloudinary support for this account, then rerun the migration. A file
is not marked fully migrated until its known old URLs return an access-denied
or not-found response. A migration exit code of 2 means CDN revocation is
pending. Previously cached or downloaded copies outside Cloudinary cannot be
recalled.

Strict per-request checks add a document read and application bandwidth per
view or download. Thumbnail transforms are fixed and source media is streamed
rather than buffered. No access-control data is cached and no recurring
background polling or database writes are added to the content endpoint.

References:
- https://fly.io/docs/reference/configuration/#the-deploy-section
- https://cloudinary.com/documentation/control_access_to_media
- https://cloudinary.com/documentation/invalidate_cached_media_assets_on_the_cdn
