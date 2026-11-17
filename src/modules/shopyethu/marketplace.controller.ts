import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    Headers,
    NotFoundException,
    Param,
    Post,
    Put,
    Query,
    Redirect,
    Req,
    UseGuards,
} from "@nestjs/common";
import { MarketplaceService } from "./marketplace.service";
import {
    MarketplaceAuthGuard,
    MarketplaceRequest,
} from "./marketplace-auth.guard";

@Controller("shopyethu")
export class MarketplacePublicController {
    constructor(private readonly market: MarketplaceService) {}
    @Get("config") config() {
        return {
            payments: "not-configured",
            collectionEnabled: true,
            deliveryCents: 0,
        };
    }
    @Get("products")
    @Header("Cache-Control", "no-store")
    async products(
        @Query("q") q = "",
        @Query("category") category = "",
        @Query("store") store = "",
        @Query("after") after = "",
        @Query("page") page = "",
        @Query("view") view = "",
    ) {
        const compact = view === "compact";
        if (page === "1" || after)
            return this.market.catalog.page(
                q.slice(0, 120),
                category.slice(0, 60),
                store.slice(0, 150),
                after,
                compact,
            );
        return {
            products: await this.market.catalog.browse(
                q.slice(0, 120),
                category.slice(0, 60),
                store.slice(0, 150),
                compact,
            ),
        };
    }
    @Get("products/:id")
    @Header("Cache-Control", "no-store")
    product(@Param("id") id: string) {
        return this.market.catalog.product(id);
    }
    @Get("product/:id")
    @Header("Cache-Control", "no-store")
    @Redirect()
    shareProduct(@Param("id") id: string) {
        if (!id || id.length > 150) {
            throw new NotFoundException("Product not found.");
        }
        return {
            url: `shopyethu://product/${encodeURIComponent(id)}`,
            statusCode: 302,
        };
    }
    @Get("stores/:id")
    @Header("Cache-Control", "no-store")
    storefront(
        @Param("id") id: string,
        @Query("page") page = "",
        @Query("view") view = "",
    ) {
        return this.market.catalog.storefront(
            id,
            page === "1",
            view === "compact",
        );
    }
    @Get("store/:id")
    @Header("Cache-Control", "no-store")
    @Redirect()
    shareStore(@Param("id") id: string) {
        if (!id || id.length > 150) {
            throw new NotFoundException("Storefront not found.");
        }
        return {
            url: `shopyethu://store/${encodeURIComponent(id)}`,
            statusCode: 302,
        };
    }
}

@Controller("shopyethu")
@UseGuards(MarketplaceAuthGuard)
export class MarketplaceCustomerController {
    constructor(private readonly market: MarketplaceService) {}
    @Get("me") me(@Req() req: MarketplaceRequest) {
        return this.market.applications.account(req.user);
    }
    @Post("application") application(
        @Req() req: MarketplaceRequest,
        @Body() body: Record<string, unknown>,
    ) {
        return this.market.applications.submit(req.user, body);
    }
    @Get("orders") async orders(@Req() req: MarketplaceRequest) {
        return { orders: await this.market.orders.list(req.user) };
    }
    @Post("orders") order(
        @Req() req: MarketplaceRequest,
        @Body() body: Record<string, unknown>,
        @Headers("idempotency-key") key: string,
    ) {
        return this.market.orders.place(req.user, body, key);
    }
    @Post("reports") report(
        @Req() req: MarketplaceRequest,
        @Body() body: Record<string, unknown>,
    ) {
        return this.market.reports.submit(req.user, body);
    }
    @Get("seller/store") mine(
        @Req() req: MarketplaceRequest,
        @Query("page") page = "",
        @Query("after") after = "",
    ) {
        return page === "1" || after
            ? this.market.catalog.minePage(req.user, after)
            : this.market.catalog.mine(req.user);
    }
    @Put("seller/store/status") sellerStoreStatus(
        @Req() req: MarketplaceRequest,
        @Body() body: { paused?: unknown },
    ) {
        return this.market.catalog.setSellerPaused(req.user, body.paused);
    }
    @Get("seller/products/:id") ownProduct(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
    ) {
        return this.market.catalog.ownProduct(req.user, id);
    }
    @Put("seller/store") store(
        @Req() req: MarketplaceRequest,
        @Body() body: Record<string, unknown>,
    ) {
        return this.market.catalog.saveStore(req.user, body);
    }
    @Post("seller/products") createProduct(
        @Req() req: MarketplaceRequest,
        @Body() body: Record<string, unknown>,
        @Headers("idempotency-key") key?: string,
    ) {
        return this.market.catalog.saveProduct(req.user, body, undefined, key);
    }
    @Put("seller/products/:id") updateProduct(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
        @Body() body: Record<string, unknown>,
        @Headers("idempotency-key") key?: string,
    ) {
        return this.market.catalog.saveProduct(req.user, body, id, key);
    }
    @Put("seller/products/:id/draft") draftProduct(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
    ) {
        return this.market.catalog.draftProduct(req.user, id);
    }
    @Delete("seller/products/:id") deleteProduct(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
    ) {
        return this.market.catalog.deleteProduct(req.user, id);
    }
    @Get("seller/orders") async incoming(@Req() req: MarketplaceRequest) {
        return { orders: await this.market.orders.list(req.user, true) };
    }
    @Put("seller/orders/:id") status(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
        @Body() body: { status?: unknown },
    ) {
        return this.market.orders.update(req.user, id, body.status);
    }
    @Put("seller/orders/:id/payment") confirmPayment(
        @Req() req: MarketplaceRequest,
        @Param("id") id: string,
    ) {
        return this.market.orders.confirmPayment(req.user, id);
    }
}
