import type { Reader, SellerApplication, Storefront } from './marketplace.types';

export async function storeNameEditable(reader: Reader, store: Storefront) {
    if (typeof store.nameEditable === 'boolean') return store.nameEditable;
    // Existing stores predate this flag. Read their original application only as
    // a fallback; new approvals carry the policy on the store itself.
    const application = await reader.get<SellerApplication>('applications', store.ownerUid);
    return application?.businessType !== 'registered-business';
}
