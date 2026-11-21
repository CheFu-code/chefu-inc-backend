import type { Firestore } from "firebase-admin/firestore";
import { COLLECTION } from "./cloudence.constants";
import type { CloudenceFileDocument } from "./cloudence.types";

const MAX_MATCHES_TO_CHECK = 100;

/** Finds existing, non-deleted files owned by the same user with identical content. */
export async function findOwnedDuplicatesByHash(
  db: Firestore,
  ownerId: string,
  sha256: string,
): Promise<CloudenceFileDocument[]> {
  const snapshot = await db
    .collection(COLLECTION)
    .where("ownerId", "==", ownerId)
    .where("sha256", "==", sha256)
    .limit(MAX_MATCHES_TO_CHECK)
    .get();

  return snapshot.docs
    .map(
      (document) =>
        ({ ...document.data(), id: document.id }) as CloudenceFileDocument,
    )
    .filter((file) => !file.isDeleted && file.ownerId === ownerId);
}
