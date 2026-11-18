import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { normalizeContactPhone } from '../auth/phone-contact';
import type { Actor, CatalogueSort, Fulfilment, MarketplaceRepository, PageOptions, Product, SellerApplication, Storefront } from './marketplace.types';
import { exists, integer, photos, seller, text } from './marketplace.validation';
import type { GooglePlacesService } from './google-places.service';
import { deleteProduct, moveProductToDraft } from './product-actions';
import { storeNameEditable } from './store-name-policy';
import { isVerifiedSeller } from './seller-verification';

function productFieldsMatch(current: Product, fields: Pick<Product, 'name' | 'description' | 'category' | 'priceCents' | 'stock' | 'photos' | 'fulfilment' | 'published'>, ownerUid: string) {
    const sameArray = <T>(left: T[], right: T[]) => left.length === right.length && left.every((value, index) => value === right[index]);
    return current.ownerUid === ownerUid && current.storeId === ownerUid &&
        current.name === fields.name && current.description === fields.description &&
        current.category === fields.category && current.priceCents === fields.priceCents &&
        current.stock === fields.stock && current.published === fields.published &&
        sameArray(current.photos, fields.photos) && sameArray(current.fulfilment, fields.fulfilment);
}

function productIdentityMatches(current: Product, fields: Pick<Product, 'name' | 'description' | 'category' | 'photos'>) {
    return current.name === fields.name &&
        current.description === fields.description &&
        current.category === fields.category &&
        current.photos.length === fields.photos.length &&
        current.photos.every((photo, index) => photo === fields.photos[index]);
}

export class CatalogService {
    constructor(private readonly repo: MarketplaceRepository, private readonly places?: Pick<GooglePlacesService, 'resolve'>) { }
    private sellerContact(store: Storefront) {
        return {
            phone: normalizeContactPhone(store.phone) || '',
            whatsappAvailable: store.whatsappAvailable === true,
        };
    }
    private publicStoreContact(store: Storefront, application?: SellerApplication | null) {
        const whatsappAvailable = typeof store.whatsappAvailable === 'boolean'
            ? store.whatsappAvailable
            : application?.whatsappAvailable;
        if (typeof whatsappAvailable !== 'boolean') return {};
        const phone =
            normalizeContactPhone(store.phone) ||
            normalizeContactPhone(application?.phone);
        return phone ? { phone, whatsappAvailable } : {};
    }
    draftProduct(actor: Actor, productId: string) { return moveProductToDraft(this.repo, actor, productId); }
    deleteProduct(actor: Actor, productId: string) { return deleteProduct(this.repo, actor, productId); }
    private productView(product: Product, store: Storefront, compact: boolean, storeVerified?: boolean) {
        return {
            ...product,
            ...(compact ? { description: '', photos: product.photos.slice(0, 1) } : {}),
            storeName: store.name,
            ...(storeVerified === undefined ? {} : { storeVerified }),
        };
    }
    private async stores(ids: string[]): Promise<Map<string, Storefront>> {
        if (this.repo.getMany) return this.repo.getMany<Storefront>('stores', ids);
        const records = await Promise.all(ids.map(async id => [id, await this.repo.get<Storefront>('stores', id)] as const));
        return new Map(records.filter((entry): entry is readonly [string, Storefront] => entry[1] !== null));
    }
    private async applications(ids: string[]): Promise<Map<string, SellerApplication>> {
        if (this.repo.getMany) return this.repo.getMany<SellerApplication>('applications', ids);
        const records = await Promise.all(ids.map(async id => [id, await this.repo.get<SellerApplication>('applications', id)] as const));
        return new Map(records.filter((entry): entry is readonly [string, SellerApplication] => entry[1] !== null));
    }
    async page(query = '', category = '', storeId = '', after = '', compact = false,
        discovery: { sort?: string; includeStoreVerification?: boolean } = {}) {
        const sort = (discovery.sort || 'newest') as CatalogueSort;
        if (!['newest', 'price-low', 'price-high'].includes(sort)) {
            throw new BadRequestException('Choose a valid product sort order.');
        }
        const options: PageOptions = {
            order: sort === 'newest'
                ? { field: 'updatedAt', direction: 'desc' }
                : { field: 'priceCents', direction: sort === 'price-low' ? 'asc' : 'desc' },
        };
        const filters: [string, string][] = [['published', 'true']];
        if (category) filters.push(['category', category]);
        if (storeId) filters.push(['storeId', storeId]);
        const page = this.repo.page
            ? await this.repo.page<Product>('products', filters, after, 24, options)
            : {
                items: (await this.repo.list<Product>('products', filters)).sort((left, right) => {
                    const field = options.order!.field === 'priceCents' ? 'priceCents' : 'updatedAt';
                    const a = left[field], b = right[field];
                    const compared = a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
                    return options.order!.direction === 'desc' ? -compared : compared;
                }),
                nextCursor: null,
            };
        // Read only stores referenced by this page, without caching permissions/visibility.
        const stores = await this.stores([...new Set(page.items.map(item => item.storeId))]);
        let verifiedStoreIds: Set<string> | undefined;
        if (discovery.includeStoreVerification) {
            const legacyOwnerIds = [...new Set(
                [...stores.values()]
                  .filter(store => store.status === 'active' && !store.sellerPaused && typeof store.verified !== 'boolean')
                  .map(store => store.ownerUid),
            )];
            const applications = legacyOwnerIds.length
                ? await this.applications(legacyOwnerIds)
                : new Map<string, SellerApplication>();
            verifiedStoreIds = new Set([...stores.entries()]
                .filter(([, store]) => typeof store.verified === 'boolean'
                  ? store.verified
                  : isVerifiedSeller(applications.get(store.ownerUid)))
                .map(([id]) => id));
        }
        return {
            products: page.items.filter(product => product.published && stores.get(product.storeId)?.status === 'active' &&
                !stores.get(product.storeId)?.sellerPaused &&
                `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase()))
                .map(product => this.productView(product, stores.get(product.storeId)!, compact, verifiedStoreIds?.has(product.storeId))), nextCursor: page.nextCursor
        };
    }
    async browse(query = '', category = '', storeId = '', compact = false) {
        const filters: [string, string][] = [['published', 'true']];
        if (storeId) filters.push(['storeId', storeId]);
        if (category) filters.push(['category', category]);
        const products = await this.repo.list<Product>('products', filters);
        const stores = await this.stores([...new Set(products.map(item => item.storeId))]);
        return products.filter(product => product.published && stores.get(product.storeId)?.status === 'active' &&
            !stores.get(product.storeId)?.sellerPaused &&
            `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase()))
            .map(product => this.productView(product, stores.get(product.storeId)!, compact));
    }
    async product(productId: string) {
        const product = exists(await this.repo.get<Product>('products', productId), 'Product');
        const store = exists(await this.repo.get<Storefront>('stores', product.storeId), 'Store');
        if (!product.published || store.status !== 'active' || store.sellerPaused) throw new BadRequestException('This listing is no longer available.');
        const application = await this.repo.get<SellerApplication>('applications', store.ownerUid);
        return { product, store: { ...store, verified: isVerifiedSeller(application) } };
    }
    async storefront(storeId: string, paginated = false, compact = false, sort = 'newest', includeStoreVerification = false) {
        const store = exists(await this.repo.get<Storefront>('stores', storeId), 'Store');
        if (store.status !== 'active' || store.sellerPaused) throw new BadRequestException('This store is currently unavailable.');
        const application = await this.repo.get<SellerApplication>('applications', store.ownerUid);
        const contact = this.publicStoreContact(store, application);
        const storefront = {
            ...store,
            ...contact,
            verified: isVerifiedSeller(application),
        };
        return paginated ? { store: storefront, ...await this.page('', '', storeId, '', compact, { sort, includeStoreVerification }) }
            : { store: storefront, products: await this.browse('', '', storeId, compact) };
    }
    async mine(actor: Actor) {
        const store = await seller(this.repo, actor);
        const [nameEditable, products] = await Promise.all([
            storeNameEditable(this.repo, store),
            this.repo.list<Product>('products', [['ownerUid', actor.uid]]),
        ]);
        return { store: { ...store, nameEditable }, products, ...this.sellerContact(store) };
    }
    async minePage(actor: Actor, after = '') {
        const store = await seller(this.repo, actor);
        if (!this.repo.page) throw new Error('Marketplace repository does not support cursor pagination.');
        const [nameEditable, page] = await Promise.all([
            storeNameEditable(this.repo, store),
            this.repo.page<Product>('products', [['ownerUid', actor.uid]], after, 24),
        ]);
        return {
            store: { ...store, nameEditable },
            products: page.items,
            nextCursor: page.nextCursor,
            ...this.sellerContact(store),
        };
    }
    async setSellerPaused(actor: Actor, paused: unknown) {
        if (typeof paused !== 'boolean') throw new BadRequestException('Store pause state must be true or false.');
        return this.repo.transaction(async tx => {
            const store = exists(await tx.get<Storefront>('stores', actor.uid), 'Store');
            if (store.ownerUid !== actor.uid) throw new ForbiddenException('You can only pause your own store.');
            if (store.status !== 'active') {
                throw new ForbiddenException(store.reason || 'Your store is suspended by CheFu staff.');
            }
            if ((store.sellerPaused ?? false) === paused) return store;
            const updated = { ...store, sellerPaused: paused, updatedAt: new Date().toISOString() };
            tx.set('stores', actor.uid, updated);
            return updated;
        });
    }
    async ownProduct(actor: Actor, productId: string) {
        const store = await seller(this.repo, actor);
        const product = exists(await this.repo.get<Product>('products', productId), 'Product');
        if (product.ownerUid !== actor.uid || product.storeId !== store.id) throw new ForbiddenException('You can only edit your own products.');
        return { store, product };
    }
    async saveStore(actor: Actor, body: Record<string, unknown>) {
        const areaPlaceId = typeof body.areaPlaceId === 'string' && body.areaPlaceId
            ? text(body.areaPlaceId, 'Operating area', 1, 256)
            : '';
        let phone: string | undefined;
        let whatsappAvailable: boolean | undefined;
        if (body.phone !== undefined) {
            phone = normalizeContactPhone(text(body.phone, 'Contact number', 7, 30)) || undefined;
            if (!phone || !/^\+27[1-9]\d{8}$/.test(phone)) {
                throw new BadRequestException('Enter a complete valid South African contact number.');
            }
            if (typeof body.whatsappAvailable !== 'boolean') {
                throw new BadRequestException('Choose whether this number is available on WhatsApp.');
            }
            whatsappAvailable = body.whatsappAvailable;
        } else if (body.whatsappAvailable !== undefined) {
            throw new BadRequestException('Provide a contact number with the WhatsApp setting.');
        }
        if (areaPlaceId && !/^[A-Za-z0-9_-]+$/.test(areaPlaceId)) {
            throw new BadRequestException('Choose a valid South African operating area.');
        }
        if (areaPlaceId) {
            if (!this.places) throw new BadRequestException('Location search is temporarily unavailable.');
            await this.places.resolve(areaPlaceId, body.areaSessionToken);
        }
        return this.repo.transaction(async tx => {
            const current = await seller(tx, actor);
            const nameEditable = await storeNameEditable(tx, current);
            const name = text(body.name, 'Store name', 2, 100);
            if (!nameEditable && name !== current.name) {
                throw new ForbiddenException('Registered businesses cannot change their store name.');
            }
            const description = text(body.description, 'Store description', 10, 2000);
            const area = areaPlaceId ? '' : text(body.area, 'Operating area', 2, 120);
            const contactChanged = phone !== undefined &&
                (phone !== normalizeContactPhone(current.phone) ||
                    whatsappAvailable !== (current.whatsappAvailable === true));
            const storeChanged = current.name !== name ||
                current.description !== description ||
                current.area !== area ||
                (current.areaPlaceId || '') !== (areaPlaceId || '') ||
                contactChanged;
            if (!storeChanged) {
                return { ...current, nameEditable };
            }
            const now = new Date().toISOString();
            const updated: Storefront = {
                ...current,
                name, nameEditable,
                description,
                area,
                ...(phone !== undefined
                    ? { phone, whatsappAvailable: whatsappAvailable === true }
                    : {}),
                ...(areaPlaceId ? { areaPlaceId } : {}),
                updatedAt: now,
            };
            if (!areaPlaceId) delete updated.areaPlaceId;
            tx.set('stores', actor.uid, updated);
            return updated;
        });
    }
    async saveProduct(actor: Actor, body: Record<string, unknown>, productId?: string, rawKey?: unknown) {
        const updating = !!productId;
        const targetId = productId || randomUUID();
        const key = rawKey === undefined ? null : text(rawKey, 'Save attempt key', 16, 120);
        const reservation = key ? createHash('sha256').update(`product:${actor.uid}:${key}`).digest('hex') : null;
        if (typeof body.published !== 'boolean') throw new BadRequestException('Choose draft or published.');
        const fulfilment = body.fulfilment;
        if (!Array.isArray(fulfilment) || fulfilment.length === 0 || fulfilment.some(value => !['collection', 'local-delivery'].includes(value))) throw new BadRequestException('Choose at least one valid fulfilment option.');
        const fields = {
            name: text(body.name, 'Product name', 2, 120), description: text(body.description, 'Description', 10, 4000),
            category: text(body.category, 'Category', 2, 60), priceCents: integer(body.priceCents, 'Price in cents', 100, 100000000),
            stock: integer(body.stock, 'Stock', 0, 100000), photos: photos(body.photos), fulfilment: [...new Set(fulfilment)] as Fulfilment[], published: body.published,
        };
        if (fields.published && !fields.photos.length) throw new BadRequestException('Add a product photo before publishing.');
        const signature = createHash('sha256').update(JSON.stringify({ fields, productId: productId || null, expectedUpdatedAt: body.expectedUpdatedAt ?? null, expectedStock: body.expectedStock ?? null })).digest('hex');
        return this.repo.transaction(async tx => {
            await seller(tx, actor);
            const previous = reservation ? await tx.get<{ signature: string; productId: string }>('idempotency', reservation) : null;
            if (previous) {
                if (previous.signature !== signature) throw new ConflictException('This save attempt was already used for different product details.');
                const saved = exists(await tx.get<Product>('products', previous.productId), 'Product');
                if (saved.ownerUid !== actor.uid) throw new ForbiddenException('You can only edit your own products.');
                return saved;
            }
            const current = await tx.get<Product>('products', targetId);
            if (current && current.ownerUid !== actor.uid) throw new ForbiddenException('You can only edit your own products.');
            if (updating) exists(current, 'Product');
            // Legacy clients can still save; new editors provide their starting version and stock.
            if (current && (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current.updatedAt ||
                body.expectedStock !== undefined && body.expectedStock !== current.stock)) {
                throw new ConflictException('This product or its stock changed. Reload the latest details before saving.');
            }
            if (current && productFieldsMatch(current, fields, actor.uid)) {
                if (reservation) tx.set('idempotency', reservation, { productId: targetId, signature });
                return current;
            }
            if (current && !productIdentityMatches(current, fields) &&
                (current.identityLocked === true || (current.reviewCount ?? 0) > 0)) {
                throw new ConflictException('This product has an order or review. Create a new listing to change its name, description, category, or photos.');
            }
            const product: Product = {
                ...fields,
                ...((current?.identityLocked === true || (current?.reviewCount ?? 0) > 0) ? { identityLocked: true } : {}),
                ...(current?.reviewCount !== undefined ? { reviewCount: current.reviewCount } : {}),
                ...(current?.ratingTotal !== undefined ? { ratingTotal: current.ratingTotal } : {}),
                id: targetId, ownerUid: actor.uid, storeId: actor.uid, updatedAt: new Date().toISOString(),
            };
            tx.set('products', targetId, product);
            if (reservation) tx.set('idempotency', reservation, { productId: targetId, signature });
            return product;
        });
    }
}
