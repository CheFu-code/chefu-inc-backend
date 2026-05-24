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
import { AuthenticatedUser } from './authenticated-user';
import { SESSION_COOKIE_NAME } from './session.constants';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
  cookies?: Record<string, string>;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.getBearerToken(request);
    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];

    try {
      const decoded = token
        ? await this.firebaseAdmin.auth().verifyIdToken(token)
        : sessionCookie
          ? await this.firebaseAdmin.auth().verifySessionCookie(sessionCookie, true)
          : null;

      if (!decoded) {
        throw new UnauthorizedException('Authentication required.');
      }

      const email = decoded.email || '';
      request.user = {
        uid: decoded.uid,
        email,
        roles: await this.getUserRoles(email),
      };

      this.logger.log(
        JSON.stringify({
          event: 'auth_guard_allowed',
          path: request.originalUrl,
          uid: decoded.uid,
          email,
          authSource: token ? 'bearer' : 'session_cookie',
          roleCount: request.user.roles.length,
        }),
      );

      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'auth_guard_denied',
          path: request.originalUrl,
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
    return authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
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
