import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CHEFU_APPS } from '../apps/app-registry';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type ArtistRequestStatus = 'all' | 'approved' | 'pending' | 'rejected';
type ReviewStatus = 'approved' | 'rejected';
type FirestoreRecord = Record<string, unknown>;

@Injectable()
export class AdminAppsService {
    constructor(
        @Inject(FirebaseAdminService)
        private readonly firebaseAdmin: FirebaseAdminService,
    ) { }

    listApps() {
        return {
            apps: CHEFU_APPS.map(app => ({
                ...app,
                tools: this.toolsForApp(app.id),
            })),
        };
    }

    async listMuzaloArtistRequests(status?: string) {
        const normalizedStatus = this.normalizeRequestStatus(status);
        const collection = this.artistRequestsCollection();
        const snapshot =
            normalizedStatus === 'all'
                ? await collection.limit(150).get()
                : await collection.where('status', '==', normalizedStatus).limit(150).get();

        const requests = snapshot.docs
            .map(doc => this.artistRequestSummary(doc.id, doc.data()))
            .sort(
                (left, right) =>
                    this.dateSortValue(right.updatedAt || right.requestedAt) -
                    this.dateSortValue(left.updatedAt || left.requestedAt),
            );

        return { requests };
    }

    async reviewMuzaloArtistRequest(
        email: string,
        body: { reviewNote?: string; status?: string },
        reviewer?: AuthenticatedUser,
    ) {
        const normalizedEmail = this.normalizeEmail(email);
        const status = this.normalizeReviewStatus(body.status);
        const reviewNote = this.normalizeText(body.reviewNote, 400);
        const db = this.firebaseAdmin.db();
        const requestRef = this.artistRequestsCollection().doc(normalizedEmail);
        const userRef = db.collection('users').doc(normalizedEmail);
        const appProfileRef = userRef.collection('appProfiles').doc('muzalo');
        const reviewedBy = reviewer?.email || reviewer?.uid || null;
        const now = FieldValue.serverTimestamp();

        await db.runTransaction(async transaction => {
            const [requestSnapshot, userSnapshot] = await Promise.all([
                transaction.get(requestRef),
                transaction.get(userRef),
            ]);

            if (!requestSnapshot.exists) {
                throw new NotFoundException('Muzalo artist request not found.');
            }

            const requestData = requestSnapshot.data() || {};
            const roles = this.normalizeRoles(userSnapshot.data()?.roles);
            const nextRoles =
                status === 'approved' && !roles.includes('artist')
                    ? [...roles, 'artist']
                    : roles;
            const spotifyArtistId =
                status === 'approved'
                    ? this.extractSpotifyArtistId(requestData.spotifyUrl)
                    : this.stringValue(requestData.spotifyArtistId);

            if (status === 'approved' && !spotifyArtistId) {
                throw new BadRequestException(
                    'A valid Spotify artist link is required before approving.',
                );
            }

            const reviewSummary = {
                reviewNote,
                reviewedAt: now,
                reviewedBy,
                ...(spotifyArtistId
                    ? {
                        spotifyArtistId,
                        spotifyUrl: this.spotifyArtistUrl(spotifyArtistId),
                    }
                    : {}),
                status,
                updatedAt: now,
            };
            const artistName = this.stringValue(requestData.artistName);

            transaction.set(requestRef, reviewSummary, { merge: true });
            transaction.set(
                appProfileRef,
                {
                    appId: 'muzalo',
                    artistProfileRequest: reviewSummary,
                    enabled: true,
                    updatedAt: now,
                },
                { merge: true },
            );
            transaction.set(
                userRef,
                {
                    ...(status === 'approved' ? { roles: nextRoles } : {}),
                    apps: {
                        muzalo: {
                            artistProfileRequest: {
                                artistName,
                                requestId: this.stringValue(requestData.requestId),
                                reviewNote,
                                reviewedAt: now,
                                reviewedBy,
                                ...(spotifyArtistId
                                    ? {
                                        spotifyArtistId,
                                        spotifyUrl: this.spotifyArtistUrl(spotifyArtistId),
                                    }
                                    : {}),
                                status,
                                updatedAt: now,
                            },
                            enabled: true,
                        },
                    },
                    updatedAt: now,
                },
                { merge: true },
            );

            if (status === 'approved' && spotifyArtistId) {
                transaction.set(
                    db.collection('muzaloArtists').doc(spotifyArtistId),
                    {
                        artistName,
                        approvedAt: now,
                        approvedBy: reviewedBy,
                        email: normalizedEmail,
                        primaryGenre: this.stringValue(requestData.primaryGenre),
                        requestId: this.stringValue(requestData.requestId),
                        source: 'artist-profile-request',
                        spotifyArtistId,
                        spotifyUrl: this.spotifyArtistUrl(spotifyArtistId),
                        status: 'approved',
                        updatedAt: now,
                        websiteUrl: this.stringValue(requestData.websiteUrl),
                    },
                    { merge: true },
                );
            }
        });

        const updated = await requestRef.get();

        return {
            request: this.artistRequestSummary(updated.id, updated.data() || {}),
            success: true,
        };
    }

    private toolsForApp(appId: string) {
        if (appId === 'flow') {
            return [
                {
                    id: 'flow-access-keys',
                    label: 'Employee access keys',
                    status: 'active',
                },
            ];
        }

        if (appId === 'muzalo') {
            return [
                {
                    id: 'muzalo-artist-requests',
                    label: 'Artist profile requests',
                    status: 'active',
                },
            ];
        }

        if (appId === 'admin') {
            return [
                {
                    id: 'admin-session',
                    label: 'Admin session gate',
                    status: 'protected',
                },
            ];
        }

        return [
            {
                id: `${appId}-overview`,
                label: 'Overview',
                status: 'planned',
            },
        ];
    }

    private artistRequestsCollection() {
        return this.firebaseAdmin.db().collection('muzaloArtistProfileRequests');
    }

    private artistRequestSummary(id: string, data: FirestoreRecord) {
        return {
            artistName: this.stringValue(data.artistName),
            email: this.stringValue(data.email) || id,
            message: this.stringValue(data.message),
            primaryGenre: this.stringValue(data.primaryGenre),
            requestId: this.stringValue(data.requestId),
            requestedAt: this.toIsoString(data.requestedAt),
            reviewNote: this.stringValue(data.reviewNote),
            reviewedAt: this.toIsoString(data.reviewedAt),
            reviewedBy: this.stringValue(data.reviewedBy),
            spotifyArtistId: this.stringValue(data.spotifyArtistId),
            spotifyUrl: this.stringValue(data.spotifyUrl),
            status: this.normalizeStoredStatus(data.status),
            uid: this.stringValue(data.uid),
            updatedAt: this.toIsoString(data.updatedAt),
            websiteUrl: this.stringValue(data.websiteUrl),
        };
    }

    private normalizeEmail(value: string) {
        const email = decodeURIComponent(value || '').trim().toLowerCase();

        if (!email || !email.includes('@')) {
            throw new BadRequestException('Valid user email required.');
        }

        return email;
    }

    private normalizeRequestStatus(value?: string): ArtistRequestStatus {
        const status = String(value || 'pending').trim().toLowerCase();

        if (['all', 'approved', 'pending', 'rejected'].includes(status)) {
            return status as ArtistRequestStatus;
        }

        throw new BadRequestException('Invalid request status filter.');
    }

    private normalizeReviewStatus(value?: string): ReviewStatus {
        const status = String(value || '').trim().toLowerCase();

        if (status === 'approved' || status === 'rejected') {
            return status;
        }

        throw new BadRequestException('Review status must be approved or rejected.');
    }

    private normalizeStoredStatus(value: unknown): ReviewStatus | 'pending' {
        const status = this.stringValue(value).toLowerCase();
        return status === 'approved' || status === 'rejected' ? status : 'pending';
    }

    private normalizeRoles(value: unknown) {
        const roles = Array.isArray(value) ? value.map(String) : ['user'];
        const normalized = roles.map(role => role.trim().toLowerCase()).filter(Boolean);

        return Array.from(new Set(normalized.length ? normalized : ['user']));
    }

    private normalizeText(value: unknown, maxLength: number) {
        return typeof value === 'string'
            ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
            : '';
    }

    private extractSpotifyArtistId(value: unknown) {
        const input = this.stringValue(value).trim();
        if (!input) return '';

        const uriMatch = input.match(/^spotify:artist:([A-Za-z0-9]{12,32})$/i);
        if (uriMatch?.[1]) return uriMatch[1];

        try {
            const url = new URL(input);
            const [, kind, artistId] = url.pathname.split('/');

            if (
                url.hostname.toLowerCase().endsWith('spotify.com') &&
                kind === 'artist' &&
                artistId &&
                /^[A-Za-z0-9]{12,32}$/.test(artistId)
            ) {
                return artistId;
            }
        } catch {
            return '';
        }

        return '';
    }

    private spotifyArtistUrl(spotifyArtistId: string) {
        return `https://open.spotify.com/artist/${spotifyArtistId}`;
    }

    private stringValue(value: unknown) {
        return typeof value === 'string' ? value : '';
    }

    private dateSortValue(value: string | null) {
        return value ? new Date(value).getTime() || 0 : 0;
    }

    private toIsoString(value: unknown) {
        if (!value) return null;
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'string' || typeof value === 'number') {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }
        if (
            typeof value === 'object' &&
            'toDate' in value &&
            typeof (value as { toDate?: unknown }).toDate === 'function'
        ) {
            const date = (value as { toDate: () => Date }).toDate();
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        }

        return null;
    }
}
