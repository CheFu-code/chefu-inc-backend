import {
    BadRequestException,
    ConflictException,
    Injectable,
    InternalServerErrorException,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type AuthenticatorTransportFuture,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { hashForAudit } from '../../common/security-audit';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type PasskeyUser = {
    email: string;
    uid: string;
};

type ChallengeKind = 'authentication' | 'registration';

type StoredChallenge = {
    challenge?: unknown;
    expiresAtMs?: unknown;
    kind?: unknown;
    uid?: unknown;
    usedAt?: unknown;
};

type StoredPasskey = {
    counter?: unknown;
    credentialId?: unknown;
    email?: unknown;
    publicKey?: unknown;
    transports?: unknown;
    uid?: unknown;
};

type PasskeyConfig = {
    origins: string[];
    rpID: string;
    rpName: string;
};

@Injectable()
export class PasskeyService {
    private readonly logger = new Logger(PasskeyService.name);

    constructor(
        private readonly firebaseAdmin: FirebaseAdminService,
        private readonly runtimeLimits: RuntimeLimitService,
    ) { }

    async createRegistrationOptions(user: PasskeyUser, clientKey: string) {
        await this.enforceRateLimit('registration-options', clientKey, 12);

        const config = this.getConfig();
        const credentials = await this.credentialsForUser(user.uid);
        const options = await generateRegistrationOptions({
            attestationType: 'none',
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
            },
            excludeCredentials: credentials.map(credential => ({
                id: credential.credentialId,
                transports: credential.transports,
            })),
            rpID: config.rpID,
            rpName: config.rpName,
            timeout: CHALLENGE_TTL_MS,
            userDisplayName: user.email,
            userID: new TextEncoder().encode(user.uid),
            userName: user.email,
        });

        const challengeId = await this.saveChallenge({
            challenge: options.challenge,
            kind: 'registration',
            uid: user.uid,
        });

        return { challengeId, options };
    }

    async verifyRegistration(
        user: PasskeyUser,
        clientKey: string,
        input: { challengeId?: string; response?: RegistrationResponseJSON },
    ) {
        await this.enforceRateLimit('registration-verify', clientKey, 12);

        if (!input.challengeId || !input.response) {
            throw new BadRequestException('Passkey registration response is required.');
        }

        const challenge = await this.claimChallenge({
            challengeId: input.challengeId,
            kind: 'registration',
            uid: user.uid,
        });
        const config = this.getConfig();

        let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;

        try {
            verification = await verifyRegistrationResponse({
                expectedChallenge: challenge as string,
                expectedOrigin: config.origins,
                expectedRPID: config.rpID,
                requireUserVerification: true,
                response: input.response,
            });
        } catch (error) {
            this.logger.warn(
                JSON.stringify({
                    event: 'passkey_registration_verification_failed',
                    emailHash: hashForAudit(user.email),
                    reason: error instanceof Error ? error.message : 'unknown',
                    uidHash: hashForAudit(user.uid),
                }),
            );
            throw new UnauthorizedException('Passkey registration could not be verified.');
        }

        if (!verification.verified || !verification.registrationInfo.userVerified) {
            throw new UnauthorizedException('Passkey registration could not be verified.');
        }

        const registration = verification.registrationInfo;
        await this.storeCredential({
            counter: registration.credential.counter,
            credentialId: registration.credential.id,
            credentialBackedUp: registration.credentialBackedUp,
            credentialDeviceType: registration.credentialDeviceType,
            email: user.email,
            publicKey: Buffer.from(registration.credential.publicKey).toString('base64url'),
            transports: registration.credential.transports || [],
            uid: user.uid,
        });

        this.logger.log(
            JSON.stringify({
                event: 'passkey_registered',
                emailHash: hashForAudit(user.email),
                uidHash: hashForAudit(user.uid),
            }),
        );

        return { ok: true };
    }

    async createAuthenticationOptions(clientKey: string) {
        await this.enforceRateLimit('authentication-options', clientKey, 30);

        const config = this.getConfig();
        const options = await generateAuthenticationOptions({
            rpID: config.rpID,
            timeout: CHALLENGE_TTL_MS,
            userVerification: 'required',
        });
        const challengeId = await this.saveChallenge({
            challenge: options.challenge,
            kind: 'authentication',
        });

        return { challengeId, options };
    }

    async verifyAuthentication(
        clientKey: string,
        input: { challengeId?: string; response?: AuthenticationResponseJSON },
    ) {
        await this.enforceRateLimit('authentication-verify', clientKey, 30);

        if (!input.challengeId || !input.response) {
            throw new BadRequestException('Passkey sign-in response is required.');
        }

        const challenge = await this.claimChallenge({
            challengeId: input.challengeId,
            kind: 'authentication',
        });
        const storedPasskey = await this.getCredential(input.response.id);

        if (!storedPasskey) {
            throw new UnauthorizedException('Passkey sign-in could not be verified.');
        }

        const config = this.getConfig();
        let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

        try {
            verification = await verifyAuthenticationResponse({
                credential: {
                    counter: storedPasskey.counter,
                    id: storedPasskey.credentialId,
                    publicKey: Buffer.from(storedPasskey.publicKey, 'base64url'),
                    transports: storedPasskey.transports,
                },
                expectedChallenge: challenge as string,
                expectedOrigin: config.origins,
                expectedRPID: config.rpID,
                requireUserVerification: true,
                response: input.response,
            });
        } catch (error) {
            this.logger.warn(
                JSON.stringify({
                    event: 'passkey_authentication_verification_failed',
                    reason: error instanceof Error ? error.message : 'unknown',
                }),
            );
            throw new UnauthorizedException('Passkey sign-in could not be verified.');
        }

        if (!verification.verified || !verification.authenticationInfo.userVerified) {
            throw new UnauthorizedException('Passkey sign-in could not be verified.');
        }

        await this.updateCredentialAfterAuthentication({
            credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
            credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
            credentialId: storedPasskey.credentialId,
            currentCounter: storedPasskey.counter,
            newCounter: verification.authenticationInfo.newCounter,
        });

        const customToken = await this.firebaseAdmin.auth().createCustomToken(
            storedPasskey.uid,
            { passkey: true },
        );

        this.logger.log(
            JSON.stringify({
                event: 'passkey_authenticated',
                emailHash: hashForAudit(storedPasskey.email),
                uidHash: hashForAudit(storedPasskey.uid),
            }),
        );

        return { customToken };
    }

    async listCredentials(uid: string) {
        const credentials = await this.credentialsForUser(uid);
        return credentials.map(credential => ({
            credentialId: credential.credentialId,
            email: credential.email,
            createdAt: undefined, // Will be populated from Firestore
            lastUsedAt: undefined, // Will be populated from Firestore
        }));
    }

    async deleteCredential(uid: string, credentialId: string) {
        if (!this.isBase64Url(credentialId)) {
            throw new BadRequestException('Invalid credential ID format.');
        }

        const credential = await this.getCredential(credentialId);

        if (!credential) {
            throw new UnauthorizedException('Credential not found.');
        }

        if (credential.uid !== uid) {
            throw new UnauthorizedException('You cannot delete this credential.');
        }

        const ref = this.credentialRef(credentialId);
        await this.firebaseAdmin.db().runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);

            if (snapshot.exists) {
                transaction.delete(ref);
            }
        });

        this.logger.log(
            JSON.stringify({
                event: 'passkey_deleted',
                emailHash: hashForAudit(credential.email),
                uidHash: hashForAudit(uid),
            }),
        );

        return { ok: true };
    }

    private async credentialsForUser(uid: string) {
        const snapshot = await this.firebaseAdmin
            .db()
            .collection('passkey_credentials')
            .where('uid', '==', uid)
            .get();

        return snapshot.docs
            .map(document => this.parseStoredPasskey(document.data()))
            .filter((credential): credential is ParsedPasskey => Boolean(credential));
    }

    private async getCredential(credentialId: string) {
        if (!this.isBase64Url(credentialId)) return null;

        const snapshot = await this.credentialRef(credentialId).get();
        if (!snapshot.exists) return null;

        return this.parseStoredPasskey(snapshot.data());
    }

    private async storeCredential(input: {
        counter: number;
        credentialBackedUp: boolean;
        credentialDeviceType: string;
        credentialId: string;
        email: string;
        publicKey: string;
        transports: AuthenticatorTransportFuture[];
        uid: string;
    }) {
        const ref = this.credentialRef(input.credentialId);

        await this.firebaseAdmin.db().runTransaction(async transaction => {
            const existing = await transaction.get(ref);
            const existingCredential = existing.exists
                ? this.parseStoredPasskey(existing.data())
                : null;

            if (existingCredential && existingCredential.uid !== input.uid) {
                throw new ConflictException('This passkey is already registered.');
            }

            transaction.set(
                ref,
                {
                    counter: input.counter,
                    credentialBackedUp: input.credentialBackedUp,
                    credentialDeviceType: input.credentialDeviceType,
                    credentialId: input.credentialId,
                    email: input.email,
                    publicKey: input.publicKey,
                    transports: input.transports,
                    uid: input.uid,
                    createdAt: existing?.data()?.createdAt || FieldValue.serverTimestamp(),
                    lastUsedAt: null,
                    updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
        });
    }

    private async updateCredentialAfterAuthentication(input: {
        credentialBackedUp: boolean;
        credentialDeviceType: string;
        credentialId: string;
        currentCounter: number;
        newCounter: number;
    }) {
        const ref = this.credentialRef(input.credentialId);

        await this.firebaseAdmin.db().runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const current = this.parseStoredPasskey(snapshot.data());

            if (!current) {
                throw new UnauthorizedException('Passkey sign-in could not be verified.');
            }

            if (
                input.currentCounter > 0 &&
                input.newCounter > 0 &&
                current.counter >= input.newCounter
            ) {
                throw new UnauthorizedException('Passkey sign-in could not be verified.');
            }

            transaction.update(ref, {
                counter: input.newCounter,
                credentialBackedUp: input.credentialBackedUp,
                credentialDeviceType: input.credentialDeviceType,
                lastUsedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
        });
    }

    private async saveChallenge(input: {
        challenge: string;
        kind: ChallengeKind;
        uid?: string;
    }) {
        const challengeId = randomUUID();
        const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;

        await this.firebaseAdmin
            .db()
            .collection('passkey_challenges')
            .doc(challengeId)
            .set({
                challenge: input.challenge,
                createdAt: FieldValue.serverTimestamp(),
                expiresAt: Timestamp.fromMillis(expiresAtMs),
                expiresAtMs,
                kind: input.kind,
                uid: input.uid || null,
            });

        return challengeId;
    }

    private async claimChallenge(input: {
        challengeId: string;
        kind: ChallengeKind;
        uid?: string;
    }) {
        if (!/^[a-f0-9-]{36}$/i.test(input.challengeId)) {
            throw new UnauthorizedException('Passkey request has expired.');
        }

        const ref = this.firebaseAdmin
            .db()
            .collection('passkey_challenges')
            .doc(input.challengeId);

        return this.firebaseAdmin.db().runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const data = snapshot.data() as StoredChallenge | undefined;
            const valid =
                snapshot.exists &&
                typeof data?.challenge === 'string' &&
                typeof data.expiresAtMs === 'number' &&
                data.expiresAtMs > Date.now() &&
                data.kind === input.kind &&
                data.uid === (input.uid || null) &&
                !data.usedAt;

            if (!valid) {
                throw new UnauthorizedException('Passkey request has expired.');
            }

            transaction.update(ref, {
                usedAt: FieldValue.serverTimestamp(),
            });

            return data.challenge;
        });
    }

    private parseStoredPasskey(value: unknown): ParsedPasskey | null {
        const data = value as StoredPasskey | undefined;
        const transports = Array.isArray(data?.transports)
            ? data.transports.filter(this.isTransport)
            : [];

        if (
            !data ||
            typeof data.uid !== 'string' ||
            typeof data.email !== 'string' ||
            typeof data.credentialId !== 'string' ||
            !this.isBase64Url(data.credentialId) ||
            typeof data.publicKey !== 'string' ||
            !this.isBase64Url(data.publicKey)
        ) {
            return null;
        }

        return {
            counter: Math.max(0, Number(data.counter) || 0),
            credentialId: data.credentialId,
            email: data.email,
            publicKey: data.publicKey,
            transports,
            uid: data.uid,
        };
    }

    private credentialRef(credentialId: string) {
        return this.firebaseAdmin
            .db()
            .collection('passkey_credentials')
            .doc(createHash('sha256').update(credentialId).digest('hex'));
    }

    private async enforceRateLimit(
        action: string,
        clientKey: string,
        limit: number,
    ) {
        const result = await this.runtimeLimits.reserve({
            collection: 'passkey_rate_limits',
            key: `${action}:${clientKey || 'unknown'}`,
            limit,
            windowMs: 5 * 60 * 1000,
        });

        if (result.limited) {
            throw new BadRequestException('Please wait and try again.');
        }
    }

    private getConfig(): PasskeyConfig {
        const configuredOrigins =
            process.env.PASSKEY_ORIGINS ||
            process.env.PASSKEY_ORIGIN ||
            process.env.CHEFU_ACCOUNT_URL ||
            (process.env.NODE_ENV === 'production'
                ? 'https://myaccount.chefuinc.com'
                : 'http://localhost:3000');
        const origins = configuredOrigins
            .split(',')
            .map(origin => origin.trim())
            .filter(Boolean)
            .map(origin => {
                try {
                    const parsed = new URL(origin);
                    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
                        throw new Error('Passkeys require HTTPS outside localhost.');
                    }
                    return parsed.origin;
                } catch {
                    throw new InternalServerErrorException('Passkey origin configuration is invalid.');
                }
            });

        if (!origins.length) {
            throw new InternalServerErrorException('Passkey origin configuration is missing.');
        }

        const rpID = (
            process.env.PASSKEY_RP_ID || new URL(origins[0]).hostname
        ).toLowerCase();
        const hasValidRpId = origins.every(origin => {
            const hostname = new URL(origin).hostname.toLowerCase();
            return hostname === rpID || hostname.endsWith(`.${rpID}`);
        });

        if (!/^[a-z0-9.-]+$/i.test(rpID) || !hasValidRpId) {
            throw new InternalServerErrorException('Passkey RP ID configuration is invalid.');
        }

        return {
            origins,
            rpID,
            rpName: process.env.PASSKEY_RP_NAME || 'CHEFU Account',
        };
    }

    private isBase64Url(value: unknown): value is string {
        return typeof value === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(value);
    }

    private isTransport(value: unknown): value is AuthenticatorTransportFuture {
        return (
            value === 'ble' ||
            value === 'cable' ||
            value === 'hybrid' ||
            value === 'internal' ||
            value === 'nfc' ||
            value === 'smart-card' ||
            value === 'usb'
        );
    }
}

type ParsedPasskey = {
    counter: number;
    credentialId: string;
    email: string;
    publicKey: string;
    transports: AuthenticatorTransportFuture[];
    uid: string;
};
