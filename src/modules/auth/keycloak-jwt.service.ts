import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, createVerify, JsonWebKey } from 'node:crypto';

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type KeycloakAccessToken = {
  aud?: string | string[];
  azp?: string;
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  preferred_username?: string;
  realm_access?: {
    roles?: unknown;
  };
  resource_access?: Record<string, { roles?: unknown }>;
  sub?: string;
};

type JwksCache = {
  expiresAt: number;
  keys: Map<string, JsonWebKey>;
};

@Injectable()
export class KeycloakJwtService {
  private readonly logger = new Logger(KeycloakJwtService.name);
  private readonly cacheTtlMs = 10 * 60 * 1000;
  private jwksCache: JwksCache | null = null;

  enabled() {
    return Boolean(this.issuer());
  }

  async verifyAccessToken(token: string) {
    const issuer = this.issuer();
    if (!issuer) {
      throw new UnauthorizedException('Keycloak is not configured.');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new UnauthorizedException('Malformed Keycloak token.');
    }

    const header = this.parseJwtPart<JwtHeader>(encodedHeader);
    const claims = this.parseJwtPart<KeycloakAccessToken>(encodedPayload);

    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new UnauthorizedException('Unsupported Keycloak token header.');
    }

    const jwk = await this.getSigningKey(header.kid);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();

    const valid = verifier.verify(
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    );

    if (!valid) {
      throw new UnauthorizedException('Invalid Keycloak token signature.');
    }

    this.validateClaims(claims, issuer);

    return {
      uid: claims.sub || '',
      email: claims.email || claims.preferred_username || '',
      roles: this.extractRoles(claims),
    };
  }

  private issuer() {
    return this.cleanUrl(
      process.env.KEYCLOAK_ISSUER ||
        this.realmUrl(
          process.env.KEYCLOAK_BASE_URL,
          process.env.KEYCLOAK_REALM,
        ),
    );
  }

  private realmUrl(baseUrl?: string, realm?: string) {
    if (!baseUrl?.trim() || !realm?.trim()) return '';
    return `${this.cleanUrl(baseUrl)}/realms/${encodeURIComponent(realm.trim())}`;
  }

  private async getSigningKey(kid: string) {
    const keys = await this.getJwks();
    const jwk = keys.get(kid);

    if (!jwk) {
      this.jwksCache = null;
      const refreshed = await this.getJwks();
      const refreshedJwk = refreshed.get(kid);
      if (refreshedJwk) return refreshedJwk;

      throw new UnauthorizedException('Unknown Keycloak signing key.');
    }

    return jwk;
  }

  private async getJwks() {
    const now = Date.now();
    if (this.jwksCache && this.jwksCache.expiresAt > now) {
      return this.jwksCache.keys;
    }

    const issuer = this.issuer();
    if (!issuer) {
      throw new UnauthorizedException('Keycloak is not configured.');
    }

    const response = await fetch(`${issuer}/protocol/openid-connect/certs`);
    if (!response.ok) {
      this.logger.warn(
        JSON.stringify({
          event: 'keycloak_jwks_fetch_failed',
          status: response.status,
        }),
      );
      throw new UnauthorizedException('Unable to load Keycloak signing keys.');
    }

    const body = (await response.json()) as { keys?: JsonWebKey[] };
    const keys = new Map<string, JsonWebKey>();
    for (const key of body.keys || []) {
      if (typeof key.kid === 'string' && key.kty === 'RSA') {
        keys.set(key.kid, key);
      }
    }

    this.jwksCache = {
      expiresAt: now + this.cacheTtlMs,
      keys,
    };

    return keys;
  }

  private validateClaims(claims: KeycloakAccessToken, issuer: string) {
    const now = Math.floor(Date.now() / 1000);

    if (!claims.sub || claims.iss !== issuer) {
      throw new UnauthorizedException('Invalid Keycloak token claims.');
    }

    if (!Number.isInteger(claims.exp) || Number(claims.exp) <= now) {
      throw new UnauthorizedException('Keycloak token has expired.');
    }

    if (Number.isInteger(claims.nbf) && Number(claims.nbf) > now + 60) {
      throw new UnauthorizedException('Keycloak token is not active yet.');
    }

    if (Number.isInteger(claims.iat) && Number(claims.iat) > now + 60) {
      throw new UnauthorizedException('Keycloak token was issued in the future.');
    }

    const allowedAudiences = this.allowedAudiences();
    if (allowedAudiences.length > 0 && !this.hasAllowedAudience(claims, allowedAudiences)) {
      throw new UnauthorizedException('Keycloak token audience is not allowed.');
    }
  }

  private allowedAudiences() {
    return String(process.env.KEYCLOAK_AUDIENCE || process.env.KEYCLOAK_CLIENT_ID || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  }

  private hasAllowedAudience(claims: KeycloakAccessToken, allowedAudiences: string[]) {
    const audiences = Array.isArray(claims.aud)
      ? claims.aud
      : typeof claims.aud === 'string'
        ? [claims.aud]
        : [];

    if (typeof claims.azp === 'string') {
      audiences.push(claims.azp);
    }

    return allowedAudiences.some(audience => audiences.includes(audience));
  }

  private extractRoles(claims: KeycloakAccessToken) {
    const roles = new Set<string>();
    const realmRoles = claims.realm_access?.roles;

    if (Array.isArray(realmRoles)) {
      realmRoles.forEach(role => {
        if (typeof role === 'string') roles.add(role);
      });
    }

    const clientId = process.env.KEYCLOAK_CLIENT_ID;
    const resourceRoles = clientId
      ? claims.resource_access?.[clientId]?.roles
      : Object.values(claims.resource_access || {}).flatMap(access => access.roles || []);

    if (Array.isArray(resourceRoles)) {
      resourceRoles.forEach(role => {
        if (typeof role === 'string') roles.add(role);
      });
    }

    return [...roles];
  }

  private parseJwtPart<T>(value: string) {
    try {
      return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
    } catch {
      throw new UnauthorizedException('Malformed Keycloak token.');
    }
  }

  private cleanUrl(value?: string) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  fingerprint(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
