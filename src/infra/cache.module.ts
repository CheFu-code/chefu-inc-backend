import { Global, Module } from "@nestjs/common";
import { LRUCache } from 'lru-cache'

export const LRU_CACHE = "LRU_CACHE";

export interface CacheInterface {
  user_id: string;
  public_id?: string;
  last_used?: string;
}

@Global()
@Module({
    providers:[
        {
            provide: LRU_CACHE,
            useFactory: () => {
                return new LRUCache<string, CacheInterface>({
                    max:10000,
                    ttl:5*60*1000,
                    updateAgeOnGet: true,
                    updateAgeOnHas: false,
                    allowStale:false
                }) 
            }
        }
    ],
    exports:[LRU_CACHE],
})

export class CacheModule {}