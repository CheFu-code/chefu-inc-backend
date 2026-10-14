Cloudence folders are personal organization inside Documents, Images, Media,
and Others. Each section shows folders and an All files view. Opening a folder
shows only its files; the section view remains available to find any file.
Folders are one level deep. Folder names can be reused in different sections.

Users can create, rename, and delete folders; Move to folder can place a file
in a folder or return it to the section root. Uploading while viewing a folder
places compatible files there. Files from another section are rejected. A
folder deleted during upload causes the commit to fail and the uploaded asset
to be cleaned up, without charging storage quota.

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

Deploy the backend before the web app. Existing files need no migration: they
initially have no personal folder placement. Folder data and API permissions
are handled by the backend; do not add direct public client access to the
metadata collection.
