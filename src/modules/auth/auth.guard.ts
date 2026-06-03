import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { auditRequestContext, hashForAudit } from '../../common/security-audit';
import { AuthenticatedUser } from './authenticated-user';
import { HoneytokenService } from './honeytoken.service';
import { OAuthService } from './oauth.service';
import {
  SESSION_COOKIE_NAME,
  SESSION_META_COOKIE_NAME,
} from './session.constants';
import { SessionSignerService } from './session-signer.service';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
  cookies?: Record<string, string>;
};

type AuthResolution = {
  source: 'firebase_bearer' | 'oauth_bearer' | 'session_cookie';
  user: AuthenticatedUser;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
    @Inject(OAuthService)
    private readonly oauthService: OAuthService,
    @Inject(HoneytokenService)
    private readonly honeytokens: HoneytokenService,
    @Inject(SessionSignerService)
    private readonly sessionSigner: SessionSignerService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    await this.honeytokens.inspectRequest(request);

    const token = this.getBearerToken(request);
    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];

    try {
      const resolution = token
        ? await this.resolveBearerUser(token, request)
        : sessionCookie
          ? await this.resolveSessionUser(sessionCookie, request)
          : null;

      if (!resolution) {
        throw new UnauthorizedException('Authentication required.');
      }

      request.user = resolution.user;

      this.logger.log(
        JSON.stringify({
          event: 'auth_guard_allowed',
          ...auditRequestContext(request),
          uidHash: hashForAudit(resolution.user.uid),
          emailHash: hashForAudit(resolution.user.email),
          authSource: resolution.source,
          roleCount: request.user.roles.length,
        }),
      );

      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'auth_guard_denied',
          ...auditRequestContext(request),
          hasBearerToken: Boolean(token),
          hasSessionCookie: Boolean(sessionCookie),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
      throw new UnauthorizedException('Authentication required.');
    }
  }

  private getBearerToken(request: Request) {
    const authorization = request.headers.authorization || '';
    if (authorization.startsWith('DPoP ')) {
      return authorization.slice('DPoP '.length);
    }

    return authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
  }

  private async resolveBearerUser(
    token: string,
    request: RequestWithUser,
  ): Promise<AuthResolution> {
    try {
      const decoded = await this.firebaseAdmin.auth().verifyIdToken(token);
      const email = decoded.email || '';

      return {
        source: 'firebase_bearer',
        user: {
          uid: decoded.uid,
          email,
          roles: await this.getUserRoles(email),
        },
      };
    } catch {
      const dpop = request.headers.dpop;
      const claims = await this.oauthService.verifyAccessToken(
        token,
        request,
        Array.isArray(dpop) ? dpop[0] : dpop,
      );
      const email = claims.email || '';

      return {
        source: 'oauth_bearer',
        user: {
          uid: claims.sub,
          email,
          roles: Array.isArray(claims.roles)
            ? claims.roles.map(String)
            : email
              ? await this.getUserRoles(email)
              : [],
        },
      };
    }
  }

  private async resolveSessionUser(
    sessionCookie: string,
    request?: RequestWithUser,
  ): Promise<AuthResolution> {
    const decoded = await this.firebaseAdmin
      .auth()
      .verifySessionCookie(sessionCookie, true);
    const email = decoded.email || '';
    const meta = this.sessionSigner.verify(
      request?.cookies?.[SESSION_META_COOKIE_NAME],
    );
    const roles =
      meta?.uid === decoded.uid && meta.email === email
        ? meta.roles
        : await this.getUserRoles(email);

    return {
      source: 'session_cookie',
      user: {
        uid: decoded.uid,
        email,
        roles,
      },
    };
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
}
