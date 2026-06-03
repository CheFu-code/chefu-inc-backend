import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { FieldValue, Transaction } from 'firebase-admin/firestore';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  KeyObject,
} from 'node:crypto';
import {
  auditRequestContext,
  hashForAudit,
} from '../../common/security-audit';
import { AppsService } from '../apps/apps.service';
import { ChefuOauthClient } from '../apps/app-registry';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { SESSION_COOKIE_NAME } from './session.constants';

type OAuthCodeDocument = {
  appId: string;
  authTime: number;
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  email: string;
  expiresAt: number;
  issuedAt: number;
  name?: string;
  nonce?: string | null;
  redirectUri: string;
  scopes: string[];
  uid: string;
  usedAt?: number | null;
};

type RefreshTokenDocument = {
  appId: string;
  clientId: string;
  dpopJkt?: string | null;
  email: string;
  expiresAt: number;
  familyId: string;
  generation: number;
  name?: string;
  parentTokenHash?: string | null;
  revokedAt?: number | null;
  revokedReason?: string | null;
  roles: string[];
  scopes: string[];
  tokenHash: string;
  uid: string;
  usedAt?: number | null;
};

type TokenClaims = {
  act?: {
    client_id?: string;
    sub: string;
  };
  aud: string;
  client_id?: string;
  cnf?: {
    jkt: string;
  };
  email?: string;
  exp: number;
  gty?: 'authorization_code' | 'client_credentials' | 'refresh_token' | 'token_exchange';
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  name?: string;
  nonce?: string;
  roles?: string[];
  scope?: string;
  sub: string;
  typ: 'access_token' | 'id_token' | 'internal_access_token';
  app?: string;
};

export type OAuthAccessTokenClaims = TokenClaims & {
  typ: 'access_token' | 'internal_access_token';
};

type AuthorizeParams = {
  client_id?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  nonce?: string;
  prompt?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
};

type TokenPayload = {
  audience?: string;
  client_assertion?: string;
  client_assertion_type?: string;
  client_id?: string;
  code?: string;
  code_verifier?: string;
  grant_type?: string;
  redirect_uri?: string;
  refresh_token?: string;
  requested_token_type?: string;
  scope?: string;
  subject_token?: string;
  subject_token_type?: string;
};

type JwtHeader = {
  alg?: unknown;
  jwk?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type JwtValidationPolicy = {
  audience: string;
  typ: TokenClaims['typ'];
};

type SigningKeyStatus = 'active' | 'next' | 'retiring';

type SigningKey = {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  status: SigningKeyStatus;
};

type DpopProof = {
  htm?: unknown;
  htu?: unknown;
  iat?: unknown;
  jti?: unknown;
  ath?: unknown;
};

type DpopVerificationResult = {
  jkt: string;
  jti: string;
};

type M2mClient = {
  allowedAudiences: string[];
  allowedScopes: string[];
  id: string;
  jwks: {
    keys: NodeJsonWebKey[];
  };
  rateLimitPerMinute: number;
};

type NodeJsonWebKey = import('node:crypto').JsonWebKey & {
  alg?: string;
  kid?: string;
  key_ops?: string[];
  use?: string;
};

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  private readonly issuer = this.cleanUrl(
    process.env.OAUTH_ISSUER ||
      process.env.PUBLIC_API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      'https://api.chefuinc.com',
  );
  private readonly accountUrl = this.cleanUrl(
    process.env.CHEFU_ACCOUNT_URL || 'https://chefuinc.com',
  );
  private readonly clockSkewSeconds = this.safeNumber(
    process.env.OAUTH_CLOCK_SKEW_SECONDS,
    60,
    0,
    300,
  );
  private readonly tokenTtlSeconds = this.safeNumber(
    process.env.OAUTH_TOKEN_TTL_SECONDS,
    3600,
    300,
    24 * 60 * 60,
  );
  private readonly authorizationCodeTtlMs = this.safeNumber(
    process.env.OAUTH_CODE_TTL_MS,
    5 * 60 * 1000,
    60 * 1000,
    10 * 60 * 1000,
  );
  private readonly refreshTokenTtlMs =
    this.safeNumber(
      process.env.OAUTH_REFRESH_TOKEN_TTL_DAYS,
      30,
      1,
      90,
    ) *
    24 *
    60 *
    60 *
    1000;
  private readonly issueRefreshTokens =
    process.env.OAUTH_ENABLE_REFRESH_TOKENS === 'true';
  private readonly dpopRequired = process.env.OAUTH_DPOP_REQUIRED === 'true';
  private readonly internalTokenTtlSeconds = this.safeNumber(
    process.env.OAUTH_INTERNAL_TOKEN_TTL_SECONDS,
    300,
    60,
    3600,
  );
  private readonly signingKeys: SigningKey[];
  private readonly dpopReplayCache = new Map<string, number>();
  private readonly clientAssertionReplayCache = new Map<string, number>();
  private readonly m2mRateBuckets = new Map<string, { count: number; resetAt: number }>();
  private readonly m2mClients = this.parseM2mClients();

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
    @Inject(AppsService)
    private readonly appsService: AppsService,
  ) {
    this.signingKeys = this.loadSigningKeys();
  }

  issuerUrl() {
    return this.issuer;
  }

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      userinfo_endpoint: `${this.issuer}/oauth/userinfo`,
      jwks_uri: `${this.issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['ES256', 'RS256'],
      scopes_supported: this.supportedScopes(),
      claims_supported: [
        'aud',
        'email',
        'exp',
        'iat',
        'iss',
        'name',
        'nbf',
        'nonce',
        'roles',
        'sub',
      ],
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      jwks_uri: `${this.issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['ES256', 'RS256'],
      scopes_supported: this.supportedScopes(),
    };
  }

  jwks() {
    return {
      keys: this.signingKeys.map(key => ({
        ...(key.publicKey.export({ format: 'jwk' }) as NodeJsonWebKey),
        kid: key.kid,
        use: 'sig',
        alg: 'RS256',
        key_ops: ['verify'],
      })),
    };
  }

  async token(body: TokenPayload, request: Request, dpop?: string) {
    if (body.grant_type === 'authorization_code') {
      return this.exchangeCode(body, request, dpop);
    }

    if (body.grant_type === 'refresh_token') {
      return this.exchangeRefreshToken(body, request, dpop);
    }

    if (body.grant_type === 'client_credentials') {
      return this.exchangeClientCredentials(body, request);
    }

    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
      return this.exchangeSubjectToken(body, request, dpop);
    }

    throw new BadRequestException('Unsupported grant_type.');
  }

  async authorize(params: AuthorizeParams, request: Request) {
    const client = this.validateAuthorizeParams(params);
    const codeChallenge = params.code_challenge;
    const redirectUri = params.redirect_uri;

    if (!codeChallenge || !redirectUri) {
      throw new BadRequestException('code_challenge and redirect_uri are required.');
    }

    const decoded = await this.getSessionUser(request);

    if (!decoded) {
      return {
        redirectTo: this.buildLoginRedirect(params, client),
      };
    }

    const scopes = this.resolveScopes(params.scope, client);
    const code = this.randomToken(32);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.authorizationCodeTtlMs;

    await this.authorizationCodes().doc(this.hash(code)).set({
      appId: client.appId,
      authTime: decoded.auth_time || Math.floor(issuedAt / 1000),
      clientId: client.id,
      codeChallenge,
      codeChallengeMethod: 'S256',
      createdAt: FieldValue.serverTimestamp(),
      email: decoded.email || '',
      expiresAt,
      issuedAt,
      name: decoded.name || decoded.email?.split('@')[0] || '',
      nonce: params.nonce || null,
      redirectUri,
      scopes,
      uid: decoded.uid,
      usedAt: null,
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);

    this.logger.log(
      JSON.stringify({
        event: 'oauth_authorization_code_issued',
        clientId: client.id,
        appId: client.appId,
        uidHash: hashForAudit(decoded.uid),
        emailHash: hashForAudit(decoded.email),
        scopes,
        ...auditRequestContext(request),
      }),
    );

    return { redirectTo: redirectUrl.toString() };
  }

  private async exchangeCode(body: TokenPayload, request: Request, dpop?: string) {
    if (body.grant_type !== 'authorization_code') {
      throw new BadRequestException('Only authorization_code grant is supported.');
    }

    if (!body.client_id || !body.code || !body.redirect_uri || !body.code_verifier) {
      throw new BadRequestException(
        'client_id, code, redirect_uri, and code_verifier are required.',
      );
    }

    const client = this.appsService.resolveOauthClient(body.client_id);
    if (!client) {
      throw new BadRequestException('Unknown OAuth client.');
    }

    const dpopProof = await this.verifyTokenEndpointDpopProof(request, dpop);
    this.validatePkceVerifier(body.code_verifier);
    const codeVerifier = body.code_verifier;

    const codeRef = this.authorizationCodes().doc(this.hash(body.code));
    const now = Date.now();
    const codeDoc = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(codeRef);
      if (!snapshot.exists) {
        this.logCodeExchangeFailure('invalid_code', body, request);
        throw new UnauthorizedException('Invalid authorization code.');
      }

      const data = snapshot.data() as OAuthCodeDocument;
      if (data.usedAt) {
        this.logCodeExchangeFailure('reused_code', body, request, data);
        throw new UnauthorizedException('Authorization code has already been used.');
      }

      if (data.expiresAt <= now) {
        this.logCodeExchangeFailure('expired_code', body, request, data);
        throw new UnauthorizedException('Authorization code has expired.');
      }

      if (data.clientId !== client.id || data.redirectUri !== body.redirect_uri) {
        this.logCodeExchangeFailure('client_or_redirect_mismatch', body, request, data);
        throw new UnauthorizedException('Authorization code does not match this client.');
      }

      try {
        this.verifyPkce(data.codeChallenge, codeVerifier);
      } catch {
        this.logCodeExchangeFailure('pkce_mismatch', body, request, data);
        throw new UnauthorizedException('Invalid PKCE verifier.');
      }

      transaction.update(codeRef, {
        usedAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return data;
    });

    const roles = await this.getUserRoles(codeDoc.email);
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const commonTokenClaims = {
      cnf: dpopProof ? { jkt: dpopProof.jkt } : undefined,
      gty: 'authorization_code' as const,
    };
    const accessToken = this.signJwt({
      ...commonTokenClaims,
      app: codeDoc.appId,
      aud: this.issuer,
      client_id: client.id,
      email: codeDoc.email,
      exp: issuedAtSeconds + this.tokenTtlSeconds,
      iat: issuedAtSeconds,
      iss: this.issuer,
      jti: this.randomToken(16),
      nbf: issuedAtSeconds,
      name: codeDoc.name,
      roles,
      scope: codeDoc.scopes.join(' '),
      sub: codeDoc.uid,
      typ: 'access_token',
    });
    const idToken = this.signJwt({
      aud: client.id,
      email: codeDoc.email,
      exp: issuedAtSeconds + this.tokenTtlSeconds,
      iat: issuedAtSeconds,
      iss: this.issuer,
      jti: this.randomToken(16),
      nbf: issuedAtSeconds,
      name: codeDoc.name,
      nonce: codeDoc.nonce || undefined,
      roles,
      sub: codeDoc.uid,
      typ: 'id_token',
    });
    const refreshToken = this.issueRefreshTokens
      ? await this.issueRefreshToken({
          appId: codeDoc.appId,
          clientId: client.id,
          dpopJkt: dpopProof?.jkt || null,
          email: codeDoc.email,
          name: codeDoc.name,
          roles,
          scopes: codeDoc.scopes,
          uid: codeDoc.uid,
        })
      : null;

    this.logger.log(
      JSON.stringify({
        event: 'oauth_token_issued',
        clientId: client.id,
        appId: codeDoc.appId,
        uidHash: hashForAudit(codeDoc.uid),
        emailHash: hashForAudit(codeDoc.email),
        scopes: codeDoc.scopes,
        ...auditRequestContext(request),
      }),
    );

    return {
      access_token: accessToken,
      id_token: idToken,
      token_type: dpopProof ? 'DPoP' : 'Bearer',
      expires_in: this.tokenTtlSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: codeDoc.scopes.join(' '),
    };
  }

  async userinfo(authorization?: string, request?: Request, dpop?: string) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : authorization?.startsWith('DPoP ')
        ? authorization.slice('DPoP '.length)
      : '';

    if (!token) {
      throw new UnauthorizedException('Missing access token.');
    }

    const claims = await this.verifyAccessToken(token, request, dpop);
    if (claims.typ !== 'access_token') {
      throw new UnauthorizedException('Access token required.');
    }

    return {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      roles: claims.roles || [],
      app: claims.app,
      scope: claims.scope,
    };
  }

  async verifyAccessToken(
    token: string,
    request?: Request,
    dpop?: string,
  ): Promise<OAuthAccessTokenClaims> {
    const claims = this.verifyJwt(token, {
      audience: this.issuer,
      typ: 'access_token',
    });
    if (claims.typ !== 'access_token') {
      throw new UnauthorizedException('Access token required.');
    }

    await this.enforceDpopBinding({
      accessToken: token,
      claims,
      dpop,
      request,
    });

    return claims as OAuthAccessTokenClaims;
  }

  verifyInternalToken(token: string, audience: string) {
    const claims = this.verifyJwt(token, {
      audience,
      typ: 'internal_access_token',
    });

    if (claims.typ !== 'internal_access_token') {
      throw new UnauthorizedException('Internal access token required.');
    }

    return claims as OAuthAccessTokenClaims;
  }

  private async exchangeRefreshToken(
    body: TokenPayload,
    request: Request,
    dpop?: string,
  ) {
    if (!this.issueRefreshTokens) {
      throw new BadRequestException('Refresh tokens are not enabled.');
    }

    if (!body.client_id || !body.refresh_token) {
      throw new BadRequestException('client_id and refresh_token are required.');
    }

    const client = this.appsService.resolveOauthClient(body.client_id);
    if (!client) {
      throw new BadRequestException('Unknown OAuth client.');
    }

    const refreshTokenHash = this.hash(body.refresh_token);
    const now = Date.now();
    const refreshRef = this.refreshTokens().doc(refreshTokenHash);
    const nextRawToken = this.randomToken(48);
    const nextHash = this.hash(nextRawToken);
    const preflightSnapshot = await refreshRef.get();
    const preflightRecord = preflightSnapshot.exists
      ? (preflightSnapshot.data() as RefreshTokenDocument)
      : null;

    if (preflightRecord?.dpopJkt) {
      const proof = await this.verifyDpopProof({
        accessToken: body.refresh_token,
        dpop,
        expectedHtm: 'POST',
        expectedHtu: `${this.issuer}/oauth/token`,
      });

      if (proof.jkt !== preflightRecord.dpopJkt) {
        throw new UnauthorizedException('DPoP key mismatch.');
      }
    } else if (this.dpopRequired) {
      throw new UnauthorizedException('DPoP proof required.');
    }

    const record = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(refreshRef);

      if (!snapshot.exists) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      const current = snapshot.data() as RefreshTokenDocument;
      if (current.clientId !== client.id) {
        throw new UnauthorizedException('Refresh token client mismatch.');
      }

      if (current.usedAt) {
        await this.revokeRefreshTokenFamily(
          transaction,
          current.familyId,
          'reuse_detected',
          now,
        );
        this.logger.warn(
          JSON.stringify({
            event: 'oauth_refresh_token_reuse_detected',
            clientId: client.id,
            familyIdHash: hashForAudit(current.familyId),
            uidHash: hashForAudit(current.uid),
            emailHash: hashForAudit(current.email),
            ...auditRequestContext(request),
          }),
        );
        throw new UnauthorizedException('Refresh token reuse detected.');
      }

      if (current.revokedAt || current.expiresAt <= now) {
        throw new UnauthorizedException('Refresh token is no longer valid.');
      }

      transaction.update(refreshRef, {
        usedAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(this.refreshTokens().doc(nextHash), {
        ...current,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: now + this.refreshTokenTtlMs,
        generation: current.generation + 1,
        parentTokenHash: refreshTokenHash,
        revokedAt: null,
        revokedReason: null,
        tokenHash: nextHash,
        updatedAt: FieldValue.serverTimestamp(),
        usedAt: null,
      });

      return current;
    });

    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const accessToken = this.signJwt({
      app: record.appId,
      aud: this.issuer,
      client_id: client.id,
      cnf: record.dpopJkt ? { jkt: record.dpopJkt } : undefined,
      email: record.email,
      exp: issuedAtSeconds + this.tokenTtlSeconds,
      gty: 'refresh_token',
      iat: issuedAtSeconds,
      iss: this.issuer,
      jti: this.randomToken(16),
      nbf: issuedAtSeconds,
      name: record.name,
      roles: record.roles,
      scope: record.scopes.join(' '),
      sub: record.uid,
      typ: 'access_token',
    });

    return {
      access_token: accessToken,
      expires_in: this.tokenTtlSeconds,
      refresh_token: nextRawToken,
      scope: record.scopes.join(' '),
      token_type: record.dpopJkt ? 'DPoP' : 'Bearer',
    };
  }

  private async exchangeSubjectToken(
    body: TokenPayload,
    request: Request,
    dpop?: string,
  ) {
    if (!body.client_id || !this.isTokenExchangeClient(body.client_id)) {
      throw new UnauthorizedException('Token exchange client is not allowed.');
    }

    if (
      !body.subject_token ||
      body.subject_token_type !== 'urn:ietf:params:oauth:token-type:access_token'
    ) {
      throw new BadRequestException('A subject access token is required.');
    }

    const audience = this.assertInternalAudience(body.audience);
    const subjectClaims = await this.verifyAccessToken(
      body.subject_token,
      request,
      dpop,
    );
    const scopes = this.resolveRequestedScopeSubset(
      body.scope,
      (subjectClaims.scope || '').split(/\s+/).filter(Boolean),
    );
    const issuedAtSeconds = Math.floor(Date.now() / 1000);

    return {
      access_token: this.signJwt({
        act: { client_id: body.client_id, sub: body.client_id },
        aud: audience,
        client_id: body.client_id,
        email: subjectClaims.email,
        exp: issuedAtSeconds + this.internalTokenTtlSeconds,
        gty: 'token_exchange',
        iat: issuedAtSeconds,
        iss: this.issuer,
        jti: this.randomToken(16),
        nbf: issuedAtSeconds,
        name: subjectClaims.name,
        roles: subjectClaims.roles || [],
        scope: scopes.join(' '),
        sub: subjectClaims.sub,
        typ: 'internal_access_token',
      }),
      expires_in: this.internalTokenTtlSeconds,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: scopes.join(' '),
      token_type: 'Bearer',
    };
  }

  private async exchangeClientCredentials(body: TokenPayload, request: Request) {
    if (!body.client_id) {
      throw new BadRequestException('client_id is required.');
    }

    const client = this.m2mClients.get(body.client_id);
    if (!client) {
      throw new UnauthorizedException('Unknown M2M client.');
    }

    this.enforceM2mRateLimit(client, request);
    await this.verifyClientAssertion(body, client);

    const audience = this.assertM2mAudience(body.audience, client);
    const scopes = this.resolveRequestedScopeSubset(
      body.scope,
      client.allowedScopes,
    );
    const issuedAtSeconds = Math.floor(Date.now() / 1000);

    return {
      access_token: this.signJwt({
        aud: audience,
        client_id: client.id,
        exp: issuedAtSeconds + this.tokenTtlSeconds,
        gty: 'client_credentials',
        iat: issuedAtSeconds,
        iss: this.issuer,
        jti: this.randomToken(16),
        nbf: issuedAtSeconds,
        roles: [],
        scope: scopes.join(' '),
        sub: client.id,
        typ: 'access_token',
      }),
      expires_in: this.tokenTtlSeconds,
      scope: scopes.join(' '),
      token_type: 'Bearer',
    };
  }

  private validateAuthorizeParams(params: AuthorizeParams) {
    if (params.response_type !== 'code') {
      throw new BadRequestException('response_type must be code.');
    }

    const client = this.appsService.resolveOauthClient(params.client_id);
    if (!client) {
      throw new BadRequestException('Unknown OAuth client.');
    }

    if (!params.redirect_uri || !this.isRegisteredRedirectUri(params.redirect_uri, client)) {
      throw new BadRequestException('Invalid redirect_uri for this client.');
    }

    if (!this.isOauthOpaqueParam(params.state, 16, 512)) {
      return this.redirectError(params, 'invalid_request', 'state is required.');
    }

    if (!this.isOauthOpaqueParam(params.nonce, 16, 512)) {
      return this.redirectError(params, 'invalid_request', 'nonce is required.');
    }

    if (
      params.code_challenge_method !== 'S256' ||
      !this.isPkceCodeChallenge(params.code_challenge)
    ) {
      return this.redirectError(params, 'invalid_request', 'PKCE S256 is required.');
    }

    if (!this.resolveScopes(params.scope, client).includes('openid')) {
      return this.redirectError(params, 'invalid_scope', 'openid scope is required.');
    }

    return client;
  }

  private redirectError(
    params: AuthorizeParams,
    error: string,
    description: string,
  ): never {
    if (!params.redirect_uri) {
      throw new BadRequestException(description);
    }

    const url = new URL(params.redirect_uri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (params.state) url.searchParams.set('state', params.state);

    throw new BadRequestException({
      error,
      error_description: description,
      redirect_to: url.toString(),
    });
  }

  private async getSessionUser(request: Request) {
    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionCookie) return null;

    try {
      return await this.firebaseAdmin.auth().verifySessionCookie(sessionCookie, true);
    } catch {
      return null;
    }
  }

  private buildLoginRedirect(params: AuthorizeParams, client: ChefuOauthClient) {
    const loginUrl = new URL('/login', this.accountUrl);
    loginUrl.searchParams.set('app', client.appId);
    loginUrl.searchParams.set('returnTo', `${this.issuer}/oauth/authorize?${new URLSearchParams({
      ...(params.client_id ? { client_id: params.client_id } : {}),
      ...(params.code_challenge ? { code_challenge: params.code_challenge } : {}),
      ...(params.code_challenge_method
        ? { code_challenge_method: params.code_challenge_method }
        : {}),
      ...(params.nonce ? { nonce: params.nonce } : {}),
      ...(params.redirect_uri ? { redirect_uri: params.redirect_uri } : {}),
      ...(params.response_type ? { response_type: params.response_type } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.state ? { state: params.state } : {}),
    }).toString()}`);
    return loginUrl.toString();
  }

  private resolveScopes(scope: string | undefined, client: ChefuOauthClient) {
    const requested = (scope || 'openid profile email')
      .split(/\s+/)
      .map(item => item.trim())
      .filter(Boolean);
    const allowed = new Set(client.scopes);

    return [...new Set(requested)].filter(item => allowed.has(item));
  }

  private supportedScopes() {
    return [
      ...new Set([
        ...this.appsService.oauthClients().flatMap(client => client.scopes),
        ...Array.from(this.m2mClients.values()).flatMap(client => client.allowedScopes),
      ]),
    ];
  }

  private activeSigningKey() {
    const active = this.signingKeys.find(key => key.status === 'active');
    if (!active) {
      throw new Error('No active OAuth signing key is configured.');
    }

    return active;
  }

  private loadSigningKeys(): SigningKey[] {
    const configuredKeys = this.parseSigningKeysJson();
    if (configuredKeys.length > 0) return configuredKeys;

    const configuredPrivateKey = process.env.OAUTH_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (configuredPrivateKey) {
      const privateKey = createPrivateKey(configuredPrivateKey);

      return [
        {
          kid: process.env.OAUTH_KEY_ID || 'chefu-oauth-production-key',
          privateKey,
          publicKey: createPublicKey(privateKey),
          status: 'active',
        },
      ];
    }

    const generated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.logger.warn(
      'OAUTH_PRIVATE_KEY is not configured. Using an ephemeral signing key; tokens will be invalid after restart.',
    );

    return [
      {
        kid: process.env.OAUTH_KEY_ID || 'chefu-oauth-dev-key',
        privateKey: generated.privateKey,
        publicKey: generated.publicKey,
        status: 'active',
      },
    ];
  }

  private parseSigningKeysJson(): SigningKey[] {
    const raw = process.env.OAUTH_SIGNING_KEYS_JSON;
    if (!raw?.trim()) return [];

    const parsed = JSON.parse(raw) as Array<{
      kid?: string;
      privateKey?: string;
      status?: SigningKeyStatus;
    }>;

    const keys = parsed
      .map(item => {
        if (!item.kid || !item.privateKey) return null;
        const privateKey = createPrivateKey(item.privateKey.replace(/\\n/g, '\n'));

        return {
          kid: item.kid,
          privateKey,
          publicKey: createPublicKey(privateKey),
          status: item.status || 'next',
        } satisfies SigningKey;
      })
      .filter((key): key is SigningKey => Boolean(key));

    if (keys.filter(key => key.status === 'active').length !== 1) {
      throw new Error('OAUTH_SIGNING_KEYS_JSON must contain exactly one active key.');
    }

    return keys;
  }

  private parseM2mClients() {
    const raw = process.env.OAUTH_M2M_CLIENTS_JSON;
    const clients = new Map<string, M2mClient>();
    if (!raw?.trim()) return clients;

    const parsed = JSON.parse(raw) as Array<{
      allowedAudiences?: string[];
      allowedScopes?: string[];
      id?: string;
      jwks?: { keys?: NodeJsonWebKey[] };
      rateLimitPerMinute?: number;
    }>;

    for (const item of parsed) {
      if (!item.id || !item.jwks?.keys?.length) continue;
      clients.set(item.id, {
        allowedAudiences: (item.allowedAudiences || [this.issuer]).map(String),
        allowedScopes: (item.allowedScopes || []).map(String),
        id: item.id,
        jwks: { keys: item.jwks.keys },
        rateLimitPerMinute: this.safeNumber(
          String(item.rateLimitPerMinute || ''),
          120,
          1,
          10_000,
        ),
      });
    }

    return clients;
  }

  private async verifyTokenEndpointDpopProof(request: Request, dpop?: string) {
    if (!dpop) {
      if (this.dpopRequired) {
        throw new UnauthorizedException('DPoP proof required.');
      }

      return null;
    }

    return this.verifyDpopProof({
      dpop,
      expectedHtm: request.method,
      expectedHtu: `${this.issuer}/oauth/token`,
    });
  }

  private async enforceDpopBinding({
    accessToken,
    claims,
    dpop,
    request,
  }: {
    accessToken: string;
    claims: TokenClaims;
    dpop?: string;
    request?: Request;
  }) {
    if (!claims.cnf?.jkt) {
      if (this.dpopRequired) {
        throw new UnauthorizedException('DPoP-bound access token required.');
      }

      return;
    }

    if (!request) {
      throw new UnauthorizedException('DPoP proof cannot be verified.');
    }

    const proof = await this.verifyDpopProof({
      accessToken,
      dpop,
      expectedHtm: request.method,
      expectedHtu: this.absoluteRequestUrl(request),
    });

    if (proof.jkt !== claims.cnf.jkt) {
      throw new UnauthorizedException('DPoP key mismatch.');
    }
  }

  private async verifyDpopProof({
    accessToken,
    dpop,
    expectedHtm,
    expectedHtu,
  }: {
    accessToken?: string;
    dpop?: string;
    expectedHtm: string;
    expectedHtu: string;
  }): Promise<DpopVerificationResult> {
    if (!dpop) {
      throw new UnauthorizedException('DPoP proof required.');
    }

    const { header, payload, signingInput, signature } = this.parseJwt(dpop);
    if (
      header.typ !== 'dpop+jwt' ||
      (header.alg !== 'ES256' && header.alg !== 'RS256') ||
      !this.isPublicJwk(header.jwk)
    ) {
      throw new UnauthorizedException('Invalid DPoP header.');
    }

    if (!this.verifyJwkSignature(header.jwk, header.alg, signingInput, signature)) {
      throw new UnauthorizedException('Invalid DPoP signature.');
    }

    const proof = payload as DpopProof;
    const now = Math.floor(Date.now() / 1000);
    if (
      proof.htm !== expectedHtm.toUpperCase() ||
      proof.htu !== expectedHtu ||
      typeof proof.jti !== 'string' ||
      !proof.jti ||
      typeof proof.iat !== 'number' ||
      !Number.isInteger(proof.iat) ||
      proof.iat < now - 300 ||
      proof.iat > now + this.clockSkewSeconds
    ) {
      throw new UnauthorizedException('Invalid DPoP proof claims.');
    }

    if (accessToken) {
      const expectedAth = this.base64Url(
        createHash('sha256').update(accessToken).digest(),
      );
      if (proof.ath !== expectedAth) {
        throw new UnauthorizedException('Invalid DPoP access token hash.');
      }
    }

    const jkt = this.jwkThumbprint(header.jwk);
    this.enforceReplayCache(this.dpopReplayCache, `dpop:${jkt}:${proof.jti}`, 300);

    return {
      jkt,
      jti: proof.jti,
    };
  }

  private async issueRefreshToken({
    appId,
    clientId,
    dpopJkt,
    email,
    name,
    roles,
    scopes,
    uid,
  }: {
    appId: string;
    clientId: string;
    dpopJkt?: string | null;
    email: string;
    name?: string;
    roles: string[];
    scopes: string[];
    uid: string;
  }) {
    const rawToken = this.randomToken(48);
    const tokenHash = this.hash(rawToken);

    await this.refreshTokens().doc(tokenHash).set({
      appId,
      clientId,
      createdAt: FieldValue.serverTimestamp(),
      dpopJkt: dpopJkt || null,
      email,
      expiresAt: Date.now() + this.refreshTokenTtlMs,
      familyId: this.randomToken(16),
      generation: 0,
      name,
      parentTokenHash: null,
      revokedAt: null,
      revokedReason: null,
      roles,
      scopes,
      tokenHash,
      uid,
      updatedAt: FieldValue.serverTimestamp(),
      usedAt: null,
    });

    return rawToken;
  }

  private async revokeRefreshTokenFamily(
    transaction: Transaction,
    familyId: string,
    reason: string,
    now: number,
  ) {
    const snapshot = await transaction.get(
      this.refreshTokens().where('familyId', '==', familyId),
    );

    snapshot.docs.forEach(doc => {
      transaction.update(doc.ref, {
        revokedAt: now,
        revokedReason: reason,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  private async verifyClientAssertion(body: TokenPayload, client: M2mClient) {
    if (
      body.client_assertion_type !==
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
      !body.client_assertion
    ) {
      throw new UnauthorizedException('private_key_jwt client assertion required.');
    }

    const { header, payload, signingInput, signature } = this.parseJwt(
      body.client_assertion,
    );
    const key =
      typeof header.kid === 'string'
        ? client.jwks.keys.find(candidate => candidate.kid === header.kid)
        : null;

    if (
      header.typ !== 'JWT' ||
      (header.alg !== 'ES256' && header.alg !== 'RS256') ||
      !key ||
      !this.isPublicJwk(key) ||
      !this.verifyJwkSignature(key, header.alg, signingInput, signature)
    ) {
      throw new UnauthorizedException('Invalid client assertion signature.');
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = payload as {
      aud?: unknown;
      exp?: unknown;
      iat?: unknown;
      iss?: unknown;
      jti?: unknown;
      sub?: unknown;
    };

    if (
      claims.iss !== client.id ||
      claims.sub !== client.id ||
      claims.aud !== `${this.issuer}/oauth/token` ||
      typeof claims.jti !== 'string' ||
      !claims.jti ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      claims.iat > now + this.clockSkewSeconds ||
      claims.exp <= now ||
      claims.exp - claims.iat > 300
    ) {
      throw new UnauthorizedException('Invalid client assertion claims.');
    }

    this.enforceReplayCache(
      this.clientAssertionReplayCache,
      `client_assertion:${client.id}:${claims.jti}`,
      300,
    );
  }

  private enforceM2mRateLimit(client: M2mClient, request: Request) {
    const now = Date.now();
    const key = `${client.id}:${request.path}`;
    const existing = this.m2mRateBuckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + 60_000 };

    bucket.count += 1;
    this.m2mRateBuckets.set(key, bucket);

    if (bucket.count > client.rateLimitPerMinute) {
      this.logger.warn(
        JSON.stringify({
          event: 'oauth_m2m_rate_limit_denied',
          clientId: client.id,
          ...auditRequestContext(request),
        }),
      );
      throw new UnauthorizedException('Client rate limit exceeded.');
    }
  }

  private assertM2mAudience(audience: string | undefined, client: M2mClient) {
    const resolved = audience || client.allowedAudiences[0] || this.issuer;

    if (!client.allowedAudiences.includes(resolved)) {
      throw new BadRequestException('Audience is not allowed for this client.');
    }

    return resolved;
  }

  private assertInternalAudience(audience?: string) {
    if (!audience) {
      throw new BadRequestException('audience is required.');
    }

    const allowed = (process.env.OAUTH_INTERNAL_AUDIENCES || [
      'admin-service',
      'flow-service',
      'muzalo-service',
      'quantum-service',
    ].join(','))
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    if (!allowed.includes(audience)) {
      throw new BadRequestException('Internal audience is not allowed.');
    }

    return audience;
  }

  private isTokenExchangeClient(clientId: string) {
    const allowed = (process.env.OAUTH_TOKEN_EXCHANGE_CLIENT_IDS || 'chefu-api-gateway')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    return allowed.includes(clientId);
  }

  private resolveRequestedScopeSubset(
    requestedScope: string | undefined,
    allowedScopes: string[],
  ) {
    const allowed = new Set(allowedScopes);
    const requested = (requestedScope || allowedScopes.join(' '))
      .split(/\s+/)
      .map(scope => scope.trim())
      .filter(Boolean);

    for (const scope of requested) {
      if (!allowed.has(scope)) {
        throw new BadRequestException(`Scope "${scope}" is not allowed.`);
      }
    }

    return [...new Set(requested)];
  }

  private parseJwt(token: string) {
    const segments = token.split('.');
    if (segments.length !== 3) {
      throw new UnauthorizedException('Malformed JWT.');
    }

    const [headerSegment, payloadSegment, signatureSegment] = segments;
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      throw new UnauthorizedException('Malformed JWT.');
    }

    return {
      header: this.parseJwtSegment(headerSegment) as JwtHeader,
      payload: this.parseJwtSegment(payloadSegment),
      signature: Buffer.from(signatureSegment, 'base64url'),
      signingInput: `${headerSegment}.${payloadSegment}`,
    };
  }

  private isPublicJwk(value: unknown): value is NodeJsonWebKey {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    const jwk = value as NodeJsonWebKey & Record<string, unknown>;
    if (
      'd' in jwk ||
      'p' in jwk ||
      'q' in jwk ||
      'dp' in jwk ||
      'dq' in jwk ||
      'qi' in jwk
    ) {
      return false;
    }

    return (
      (jwk.kty === 'RSA' &&
        typeof jwk.n === 'string' &&
        typeof jwk.e === 'string') ||
      (jwk.kty === 'EC' &&
        jwk.crv === 'P-256' &&
        typeof jwk.x === 'string' &&
        typeof jwk.y === 'string')
    );
  }

  private verifyJwkSignature(
    jwk: NodeJsonWebKey,
    alg: unknown,
    signingInput: string,
    signature: Buffer,
  ) {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify(alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
    verifier.update(signingInput);
    verifier.end();

    if (alg === 'ES256') {
      return verifier.verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    }

    return verifier.verify(publicKey, signature);
  }

  private jwkThumbprint(jwk: NodeJsonWebKey) {
    if (jwk.kty === 'RSA') {
      return this.base64Url(
        createHash('sha256')
          .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
          .digest(),
      );
    }

    if (jwk.kty === 'EC') {
      return this.base64Url(
        createHash('sha256')
          .update(
            JSON.stringify({
              crv: jwk.crv,
              kty: jwk.kty,
              x: jwk.x,
              y: jwk.y,
            }),
          )
          .digest(),
      );
    }

    throw new UnauthorizedException('Unsupported JWK type.');
  }

  private enforceReplayCache(
    cache: Map<string, number>,
    key: string,
    ttlSeconds: number,
  ) {
    const now = Date.now();

    for (const [cacheKey, expiresAt] of cache.entries()) {
      if (expiresAt <= now) cache.delete(cacheKey);
    }

    if (cache.has(key)) {
      throw new UnauthorizedException('Replay detected.');
    }

    cache.set(key, now + ttlSeconds * 1000);
  }

  private absoluteRequestUrl(request: Request) {
    return `${this.issuer}${request.path}`;
  }

  private isRegisteredRedirectUri(redirectUri: string, client: ChefuOauthClient) {
    if (!client.redirectUris.includes(redirectUri)) return false;

    try {
      const url = new URL(redirectUri);
      return !url.hash && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  private isOauthOpaqueParam(
    value: string | undefined,
    minLength: number,
    maxLength: number,
  ) {
    return (
      typeof value === 'string' &&
      value.length >= minLength &&
      value.length <= maxLength &&
      /^[A-Za-z0-9._~:-]+$/.test(value)
    );
  }

  private isPkceCodeChallenge(value: string | undefined) {
    return (
      typeof value === 'string' &&
      value.length === 43 &&
      /^[A-Za-z0-9_-]+$/.test(value)
    );
  }

  private validatePkceVerifier(codeVerifier: string) {
    if (
      codeVerifier.length < 43 ||
      codeVerifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(codeVerifier)
    ) {
      throw new UnauthorizedException('Invalid PKCE verifier.');
    }
  }

  private verifyPkce(codeChallenge: string, codeVerifier: string) {
    this.validatePkceVerifier(codeVerifier);

    const actual = this.base64Url(createHash('sha256').update(codeVerifier).digest());
    const expectedBuffer = Buffer.from(codeChallenge);
    const actualBuffer = Buffer.from(actual);

    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new UnauthorizedException('Invalid PKCE verifier.');
    }
  }

  private signJwt(claims: TokenClaims) {
    const signingKey = this.activeSigningKey();
    const header = this.base64UrlJson({
      alg: 'RS256',
      kid: signingKey.kid,
      typ: 'JWT',
    });
    const payload = this.base64UrlJson(claims);
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(signingKey.privateKey);

    return `${signingInput}.${this.base64Url(signature)}`;
  }

  private verifyJwt(token: string, policy: JwtValidationPolicy) {
    const segments = token.split('.');
    if (segments.length !== 3) {
      throw new UnauthorizedException('Malformed access token.');
    }

    const [headerSegment, payloadSegment, signatureSegment] = segments;
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      throw new UnauthorizedException('Malformed access token.');
    }

    const header = this.parseJwtSegment(headerSegment) as JwtHeader;
    if (
      header.typ !== 'JWT' ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string'
    ) {
      throw new UnauthorizedException('Unsupported token signing key.');
    }

    const signingKey = this.signingKeys.find(key => key.kid === header.kid);
    if (!signingKey) {
      throw new UnauthorizedException('Unsupported token signing key.');
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();

    const signature = Buffer.from(signatureSegment, 'base64url');
    if (!verifier.verify(signingKey.publicKey, signature)) {
      throw new UnauthorizedException('Invalid access token signature.');
    }

    const claims = this.parseJwtSegment(payloadSegment) as TokenClaims;
    this.validateJwtClaims(claims, policy);

    return claims;
  }

  private validateJwtClaims(
    claims: Partial<TokenClaims>,
    policy: JwtValidationPolicy,
  ): asserts claims is TokenClaims {
    const now = Math.floor(Date.now() / 1000);
    const { exp, iat, nbf } = claims;

    if (
      claims.iss !== this.issuer ||
      claims.aud !== policy.audience ||
      claims.typ !== policy.typ ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.jti !== 'string' ||
      !claims.jti ||
      typeof iat !== 'number' ||
      typeof nbf !== 'number' ||
      typeof exp !== 'number' ||
      !Number.isInteger(iat) ||
      !Number.isInteger(nbf) ||
      !Number.isInteger(exp)
    ) {
      throw new UnauthorizedException('Access token claims are invalid.');
    }

    if (iat > now + this.clockSkewSeconds) {
      throw new UnauthorizedException('Access token was issued in the future.');
    }

    if (nbf > now + this.clockSkewSeconds) {
      throw new UnauthorizedException('Access token is not active yet.');
    }

    if (exp <= now - this.clockSkewSeconds) {
      throw new UnauthorizedException('Access token has expired.');
    }

    if (exp - iat > this.tokenTtlSeconds + this.clockSkewSeconds) {
      throw new UnauthorizedException('Access token lifetime is invalid.');
    }

    if (
      claims.roles !== undefined &&
      (!Array.isArray(claims.roles) ||
        !claims.roles.every(role => typeof role === 'string'))
    ) {
      throw new UnauthorizedException('Access token roles claim is invalid.');
    }
  }

  private async getUserRoles(email: string) {
    if (!email) return [];

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .get();
    const roles = snapshot.data()?.roles;
    return Array.isArray(roles) ? roles.map(String) : [];
  }

  private parseJwtSegment(segment: string) {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new UnauthorizedException('Malformed access token.');
    }
  }

  private authorizationCodes() {
    return this.firebaseAdmin.db().collection('oauth_authorization_codes');
  }

  private refreshTokens() {
    return this.firebaseAdmin.db().collection('oauth_refresh_tokens');
  }

  private logCodeExchangeFailure(
    reason: string,
    body: Pick<TokenPayload, 'client_id' | 'code' | 'redirect_uri'>,
    request?: Request,
    codeDoc?: Partial<OAuthCodeDocument>,
  ) {
    this.logger.warn(
      JSON.stringify({
        event: 'oauth_code_exchange_failed',
        reason,
        clientId: body.client_id || null,
        appId: codeDoc?.appId || null,
        codeHash: hashForAudit(body.code),
        redirectUriHash: hashForAudit(body.redirect_uri),
        expectedClientId: codeDoc?.clientId || null,
        expectedRedirectUriHash: hashForAudit(codeDoc?.redirectUri),
        uidHash: hashForAudit(codeDoc?.uid),
        emailHash: hashForAudit(codeDoc?.email),
        ...auditRequestContext(request),
      }),
    );
  }

  private randomToken(bytes: number) {
    return this.base64Url(randomBytes(bytes));
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private base64UrlJson(value: unknown) {
    return this.base64Url(Buffer.from(JSON.stringify(value)));
  }

  private base64Url(value: Buffer) {
    return value.toString('base64url');
  }

  private cleanUrl(value: string) {
    return value.replace(/\/$/, '');
  }

  private safeNumber(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.min(Math.max(Math.round(parsed), minimum), maximum);
  }
}
