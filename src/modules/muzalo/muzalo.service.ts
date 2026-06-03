import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type ArtistProfileRequestInput = {
  artistName?: string;
  message?: string;
  primaryGenre?: string;
  spotifyUrl?: string;
  websiteUrl?: string;
};

type StoredArtistProfileRequest = {
  artistName?: unknown;
  message?: unknown;
  primaryGenre?: unknown;
  requestedAt?: unknown;
  requestId?: unknown;
  reviewedAt?: unknown;
  reviewedBy?: unknown;
  spotifyUrl?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  websiteUrl?: unknown;
};

@Injectable()
export class MuzaloService {
  private readonly logger = new Logger(MuzaloService.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async getProfile(user: AuthenticatedUser) {
    const appProfile = await this.appProfileSnapshot(user.email);

    return {
      artistProfile: this.artistProfileSummary(
        appProfile.data()?.artistProfileRequest,
        user.roles,
      ),
    };
  }

  async requestArtistProfile(
    user: AuthenticatedUser,
    input: ArtistProfileRequestInput,
  ) {
    if (this.hasArtistRole(user.roles)) {
      throw new BadRequestException(
        'This account already has an artist profile.',
      );
    }

    const normalized = this.normalizeArtistProfileRequest(input);
    const db = this.firebaseAdmin.db();
    const userRef = db.collection('users').doc(user.email);
    const appProfileRef = userRef.collection('appProfiles').doc('muzalo');
    const requestRef = db.collection('muzaloArtistProfileRequests').doc(user.email);
    const appProfile = await appProfileRef.get();
    const existing = appProfile.data()?.artistProfileRequest as
      | StoredArtistProfileRequest
      | undefined;
    const existingStatus = this.stringValue(existing?.status).toLowerCase();

    if (existingStatus === 'approved') {
      throw new BadRequestException(
        'This account already has an approved artist profile request.',
      );
    }

    const requestId = this.stringValue(existing?.requestId) || randomUUID();
    const now = FieldValue.serverTimestamp();
    const artistProfileRequest = {
      ...normalized,
      requestId,
      status: 'pending',
      requestedAt: existing?.requestedAt || now,
      updatedAt: now,
    };

    await Promise.all([
      appProfileRef.set(
        {
          appId: 'muzalo',
          enabled: true,
          artistProfileRequest,
          updatedAt: now,
        },
        { merge: true },
      ),
      requestRef.set(
        {
          ...artistProfileRequest,
          email: user.email,
          uid: user.uid,
        },
        { merge: true },
      ),
      userRef.set(
        {
          apps: {
            muzalo: {
              enabled: true,
              artistProfileRequest: {
                artistName: normalized.artistName,
                requestId,
                status: 'pending',
                updatedAt: now,
              },
            },
          },
          updatedAt: now,
        },
        { merge: true },
      ),
    ]);

    this.logger.log(
      JSON.stringify({
        event: 'muzalo_artist_profile_requested',
        email: user.email,
        requestId,
      }),
    );

    const nextProfile = await appProfileRef.get();

    return {
      artistProfile: this.artistProfileSummary(
        nextProfile.data()?.artistProfileRequest,
        user.roles,
      ),
      ok: true,
    };
  }

  private async appProfileSnapshot(email: string) {
    return this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .collection('appProfiles')
      .doc('muzalo')
      .get();
  }

  private normalizeArtistProfileRequest(input: ArtistProfileRequestInput) {
    const artistName = this.normalizeText(input.artistName, 80);

    if (!artistName) {
      throw new BadRequestException('Artist name is required.');
    }

    return {
      artistName,
      message: this.normalizeText(input.message, 700),
      primaryGenre: this.normalizeText(input.primaryGenre, 60),
      spotifyUrl: this.normalizeOptionalUrl(input.spotifyUrl),
      websiteUrl: this.normalizeOptionalUrl(input.websiteUrl),
    };
  }

  private artistProfileSummary(
    value: unknown,
    roles: string[],
  ) {
    if (this.hasArtistRole(roles)) {
      return {
        status: 'approved',
      };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        status: 'none',
      };
    }

    const request = value as StoredArtistProfileRequest;
    const status = this.stringValue(request.status).toLowerCase();

    return {
      artistName: this.stringValue(request.artistName),
      message: this.stringValue(request.message),
      primaryGenre: this.stringValue(request.primaryGenre),
      requestedAt: this.timestampToIso(request.requestedAt),
      requestId: this.stringValue(request.requestId),
      reviewedAt: this.timestampToIso(request.reviewedAt),
      reviewedBy: this.stringValue(request.reviewedBy),
      spotifyUrl: this.stringValue(request.spotifyUrl),
      status: ['pending', 'approved', 'rejected'].includes(status)
        ? status
        : 'none',
      updatedAt: this.timestampToIso(request.updatedAt),
      websiteUrl: this.stringValue(request.websiteUrl),
    };
  }

  private hasArtistRole(roles: string[]) {
    return roles.some(role => role.trim().toLowerCase() === 'artist');
  }

  private normalizeText(value: unknown, maxLength: number) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  private normalizeOptionalUrl(value: unknown) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';

    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      return url.toString().slice(0, 240);
    } catch {
      throw new BadRequestException('Enter a valid artist link.');
    }
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value : '';
  }

  private timestampToIso(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      return (value as { toDate: () => Date }).toDate().toISOString();
    }

    return typeof value === 'string' ? value : null;
  }
}
