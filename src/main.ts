import "./instrument";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import compression from "compression";
import { AppModule } from "./app.module";
import { Logger } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { validateBackendEnv } from "./common/env";
import { GlobalExceptionFilter } from "./common/global-exception.filter";
import { ValidationPipe } from "@nestjs/common";
import { registeredAppOrigins } from "./modules/apps/app-registry";
import {
    captureFlowInboundRawBody,
    configureCors,
    createCookieCsrfMiddleware,
    createSecurityHeadersMiddleware,
    normalizeOrigin,
} from "./common/http-security";
import { getTrustedProxyAddresses } from "./common/proxy-trust";

function getAllowedOrigins() {
    const configuredOrigins =
        process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN;
    const defaults = registeredAppOrigins();
    const origins = configuredOrigins
        ? [...defaults, ...configuredOrigins.split(",")]
        : defaults;

    return [
        ...new Set(
            origins
                .map((origin) => normalizeOrigin(origin.trim()))
                .filter((origin): origin is string => Boolean(origin)),
        ),
    ];
}

async function bootstrap() {
    const logger = new Logger("Bootstrap");
    const envValidation = validateBackendEnv();

    if (!envValidation.isValid && envValidation.error) {
        logger.error(envValidation.error.message);
        throw envValidation.error;
    }

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        bodyParser: false,
        logger: ['warn', 'error'],
    });
    const allowedOrigins = getAllowedOrigins();
    const trustedProxyAddresses = getTrustedProxyAddresses(
        process.env.TRUSTED_PROXY_IPS,
    );
    app.set('trust proxy', trustedProxyAddresses);

    // Compress all JSON responses with gzip/brotli.
    // A 50-file list response drops from ~25 KB to ~5 KB (80% reduction).
    app.use(compression());

    // Body parser limits: uploads now use multipart (multer), so the JSON body parser
    // only needs to handle small payloads like rename/share requests (~1 KB each).
    // 4 MB provides ample headroom while blocking JSON-body DoS attacks.
    app.useBodyParser("json", {
        limit: "4mb",
        verify: captureFlowInboundRawBody,
    });
    app.useBodyParser("urlencoded", { extended: true, limit: "4mb" });
    app.use(cookieParser());
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );

    configureCors(app, allowedOrigins);
    app.use(createSecurityHeadersMiddleware());
    app.use(createCookieCsrfMiddleware(allowedOrigins));
    app.useGlobalFilters(new GlobalExceptionFilter());

    const port = Number(process.env.PORT || 4000);
    await app.listen(port, "0.0.0.0");
    logger.log(
        JSON.stringify({
            event: "api_started",
            port,
            host: "0.0.0.0",
            nodeEnv: process.env.NODE_ENV || "development",
            allowedOrigins,
            trustedProxyCount: trustedProxyAddresses.length,
            authCookieDomain: process.env.AUTH_COOKIE_DOMAIN || null,
        }),
    );
}

void bootstrap();
