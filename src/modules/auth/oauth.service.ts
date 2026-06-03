import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
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

type TokenClaims = {
  aud: string;
  client_id?: string;
  email?: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  name?: string;
  nonce?: string;
  roles?: string[];
  scope?: string;
  sub: string;
  typ: 'access_token' | 'id_token';
  app?: string;
};

export type OAuthAccessTokenClaims = TokenClaims & {
  typ: 'access_token';
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
  client_id?: string;
  code?: string;
  code_verifier?: string;
  grant_type?: string;
  redirect_uri?: string;
};

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type JwtValidationPolicy = {
  audience: string;
  typ: TokenClaims['typ'];
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
  private readonly keyId = process.env.OAUTH_KEY_ID || 'chefu-oauth-dev-key';
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
    @Inject(AppsService)
    private readonly appsService: AppsService,
  ) {
    const configuredPrivateKey = process.env.OAUTH_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (configuredPrivateKey) {
      this.privateKey = createPrivateKey(configuredPrivateKey);
      this.publicKey = createPublicKey(this.privateKey);
      return;
    }

    const generated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = generated.privateKey;
    this.publicKey = generated.publicKey;
    this.logger.warn(
      'OAUTH_PRIVATE_KEY is not configured. Using an ephemeral signing key; tokens will be invalid after restart.',
    );
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
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
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
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: this.supportedScopes(),
    };
  }

  jwks() {
    const jwk = this.publicKey.export({ format: 'jwk' }) as JsonWebKey;

    return {
      keys: [
        {
          ...jwk,
          kid: this.keyId,
          use: 'sig',
          alg: 'RS256',
          key_ops: ['verify'],
        },
      ],
    };
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

  async exchangeCode(body: TokenPayload, request?: Request) {
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
    const accessToken = this.signJwt({
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
      token_type: 'Bearer',
      expires_in: this.tokenTtlSeconds,
      scope: codeDoc.scopes.join(' '),
    };
  }

  async userinfo(authorization?: string) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';

    if (!token) {
      throw new UnauthorizedException('Missing access token.');
    }

    const claims = this.verifyJwt(token, {
      audience: this.issuer,
      typ: 'access_token',
    });
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

  verifyAccessToken(token: string): OAuthAccessTokenClaims {
    const claims = this.verifyJwt(token, {
      audience: this.issuer,
      typ: 'access_token',
    });
    if (claims.typ !== 'access_token') {
      throw new UnauthorizedException('Access token required.');
    }

    return claims as OAuthAccessTokenClaims;
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
    return [...new Set(this.appsService.oauthClients().flatMap(client => client.scopes))];
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
    const header = this.base64UrlJson({
      alg: 'RS256',
      kid: this.keyId,
      typ: 'JWT',
    });
    const payload = this.base64UrlJson(claims);
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.privateKey);

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
      typeof header.kid !== 'string' ||
      header.kid !== this.keyId
    ) {
      throw new UnauthorizedException('Unsupported token signing key.');
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();

    const signature = Buffer.from(signatureSegment, 'base64url');
    if (!verifier.verify(this.publicKey, signature)) {
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
