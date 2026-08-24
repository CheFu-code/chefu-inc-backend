export const VERSION = 'v1'

export type CachedKey = {
    userID: string;
    apiKeyDigest: string;
    expireAt: number
}