# Seller product actions

`PUT /shopyethu/seller/products/:id/draft` and `DELETE /shopyethu/seller/products/:id` require marketplace authentication. Both recheck the seller's current active store and product ownership inside a Firestore transaction. A stale mobile session cannot bypass suspension or act on another seller's listing.

Move to draft updates only publication status and `updatedAt`, preserving the latest stock, prices and product edits. Existing drafts return unchanged without a write. The normal product editor can publish the draft again after its usual validation.

Deletion removes the product document from `shopyethu_products`. A minimal receipt in `shopyethu_deleted_products` stores the product ID, store ID, owner UID and deletion time. This allows a lost-response retry to return the original result without more writes. Retried saves and stale editors cannot recreate the deleted product. A committed deletion also invalidates the backend's public product cache.

Existing orders remain valid. Orders already store their own item name, photo URL, quantity and price, and seller fulfilment works from the order record. Deletion does not cancel orders, alter payment status or issue refunds. Photo assets remain hosted because existing order snapshots may reference them. Cancelling an eligible order skips restocking a product that no longer exists and does not recreate the listing. A basket submitted after deletion is rejected by the existing transactional checkout checks. Concurrent checkout/deletion is serialized by Firestore's transaction conflict detection.

The app offers these actions through each inventory row's three-dot menu. Delete requires a separate confirmation. Pending requests lock repeat taps and dismissal; failed requests leave an inline error and can be retried. Successful server responses update the shared inventory and catalogue caches without an immediate inventory GET.

Deploy the backend before releasing the mobile actions. Automated checks cover authorization, partial draft updates, repeated requests, order preservation and fulfilment after deletion, missing listings, stale saves, public-cache invalidation, confirmation and duplicate taps. These tests do not constitute a live-device acceptance check.
