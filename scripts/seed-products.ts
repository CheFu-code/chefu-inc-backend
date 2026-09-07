import admin from 'firebase-admin';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is required for product seeding.');
const inventory = Number(process.env.SEED_PRODUCT_INVENTORY);
if (!Number.isInteger(inventory) || inventory < 0) throw new Error('Set SEED_PRODUCT_INVENTORY to an explicit non-negative development quantity.');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount) });
const db = admin.firestore();
const now = new Date().toISOString();
const products = [
  ['CHEFU Desk Mat', 'chefu-desk-mat', 'CHEFU-DESK-MAT', 'Desk Accessories', 'A premium minimalist desk mat designed for developers, creators, students, and professionals.', 34900],
  ['CHEFU Cable & Tech Kit', 'chefu-cable-tech-kit', 'CHEFU-TECH-KIT', 'Tech Accessories', 'A compact technology accessory kit designed to keep everyday cables and small tech essentials organized.', 24900],
  ['CHEFU Developer Kit', 'chefu-developer-kit', 'CHEFU-DEVELOPER-KIT', 'Developer / Bundles', 'A premium CHEFU technology bundle designed for developers and technology enthusiasts.', 99900],
] as const;
for (const [name, slug, sku, category, description, priceMinor] of products) {
  const id = `prod_seed_${slug}`;
  await db.collection('products').doc(id).set({ id, name, slug, sku, category, description, shortDescription: description, priceMinor, currency: 'ZAR', images: [], variants: name === 'CHEFU Developer Kit' ? [{ id: 'standard', name: 'Standard', sku: `${sku}-STANDARD`, priceMinor: 99900, inventoryQuantity: inventory, options: { edition: 'Standard' } }, { id: 'pro', name: 'Pro', sku: `${sku}-PRO`, priceMinor: 129900, inventoryQuantity: inventory, options: { edition: 'Pro' } }] : [], inventoryQuantity: inventory, lowStockThreshold: 5, status: inventory > 0 ? 'ACTIVE' : 'OUT_OF_STOCK', featured: true, tags: ['chefu', 'technology'], metadata: {}, productType: 'PHYSICAL', stockTracking: true, createdAt: now, updatedAt: now, createdBy: 'seed-script' }, { merge: true });
}
console.log(`Seeded ${products.length} products with inventory ${inventory}.`);