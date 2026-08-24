import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

export const REDIS_CLIENT = "REDIS_CLIENT";

@Global()
@Module({
    providers: [
        {
            provide: REDIS_CLIENT,
            useFactory: (configService: ConfigService) => {
                const redis = new Redis({
                    host: configService.get<string>("REDIS_HOST", "localhost"),
                    port: configService.get<number>("REDIS_PORT", 6379),
                    password: configService.get<string>("REDIS_PASSWORD") || undefined,
                    db: configService.get("REDIS_DB", 0),
                    retryStrategy: (times) => {
                        if (times > 3) return null;
                        return Math.min(times * 200, 2000);
                    },
                });

                redis.on('connect',()=> console.log('redis connected',redis.status));

                redis.on('error',(error)=> console.error('redis error',error));

                return redis;
            },
            inject: [ConfigService],
        },
    ],
    exports: [REDIS_CLIENT],
})
export class RedisModule{ }
