import { createHash, randomInt, timingSafeEqual } from 'crypto';

export function generateOtp(length = 6): string {
    const min = 10 ** (length - 1);
    const max = 10 ** length;

    return randomInt(min, max).toString();
}

export function hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
}

export function verifyOtpHash(
    otp: string,
    expectedHash: string,
): boolean {
    const actualHash = hashOtp(otp);

    const actual = Buffer.from(actualHash, 'hex');
    const expected = Buffer.from(expectedHash, 'hex');

    if (actual.length !== expected.length) {
        return false;
    }

    return timingSafeEqual(actual, expected);
}