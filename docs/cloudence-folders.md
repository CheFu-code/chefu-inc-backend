Cloudence folders are personal organization inside Documents, Images, Media,
and Others. Each section shows folder cards and an All files area containing
only files outside folders. Opening a folder shows its contents. Moving files
into a folder removes them from the section's loose-file list; deleting the
folder restores those files to that list.
Folders are one level deep. Folder names can be reused in different sections.

Users can create, rename, and delete folders; Move to folder can place a file
in a folder or return it to the section root. Uploading while viewing a folder
places compatible files there. Files from another section are rejected. A
folder deleted during upload causes the commit to fail and the uploaded asset
to be cleaned up, without charging storage quota.

Bulk moves select up to 50 displayed files and use one atomic operation. Every
file must still be readable, and every destination must match its section.
One invalid file rejects the entire move. Selection does not carry into a
different folder or page. Folder search, folder sorting, and loose-file
filtering work locally without API calls. Folder labels appear in grid
and list views. Loose-file filtering and file sorting apply to the currently
displayed files, as the UI labels indicate. Page navigation preserves file
search and sort settings; it does not claim global sorting of an entire folder.

Folder placement belongs to the viewing user, including files shared with
them. Moving a shared file does not organize it for its owner or other
recipients. Folders do not grant access, and sharing remains per file. Deleted,
revoked, or expired files cannot be listed or moved through a folder.
Deleting a folder removes organization only and never deletes its files.

Metadata is stored in one `cloudenceFolders/{uid}` document containing folders
and file-to-folder placements. Folder writes use transactions to preserve
concurrent changes. The limits are 100 folders and 5,000 placements per user,
keeping the metadata document within Firestore's size limit.

Section requests include folder metadata in the existing files API response,
adding one metadata read. Folder views read at most 100 selected file documents
per page; there is no scan of all storage assets, polling, recurring background
work, or extra Cloudinary copies. Moves read the file and metadata and write
only metadata. Folder deletion writes one metadata document without rewriting
every file. Uploads into folders add metadata validation and one transactional
metadata write. Dashboard and global search do not request folder metadata.

Explicit folder mutations check up to 20 existing placements for deleted,
revoked, or expired files and rotate a cursor through the metadata. Known files
from the current move are reused. This adds at most 20 file reads per folder
mutation and no extra metadata write beyond that mutation. Deleting an owned
file adds one metadata read and removes its placement transactionally if
present. Other users' stale placements are cleaned during their own explicit
actions, without fan-out writes. **Clean up folders** checks at most 100
placements per click; **Continue cleanup** lets the user continue the pass.
No cleanup worker, timer, or request-time listing writes are introduced.

The permanent browser regression test lives in
`Cloudence-web/tests/folders.browser.test.cjs`. After building the web app, run
`npm run test:folders:browser`. It uses an isolated mock API and checks local
folder search/sort, single and bulk moves, loose-file visibility, rename, deletion, cleanup,
and restored pointer access after opening an action dialog. It uses Puppeteer
from the backend workspace, or a module specified by `PUPPETEER_MODULE` for
standalone checkouts. `PUPPETEER_EXECUTABLE_PATH` can select a Chrome/Chromium
binary. Browser requests outside the local test server are blocked.

Deploy the backend before the web app. Existing files need no migration: they
initially have no personal folder placement. Folder data and API permissions
are handled by the backend; do not add direct public client access to the
metadata collection.
