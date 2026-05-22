import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from './authenticated-user';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const isAdmin = request.user?.roles.some(
      role => role.toLowerCase() === 'admin',
    );

    if (!isAdmin) {
      this.logger.warn(
        JSON.stringify({
          event: 'admin_guard_denied',
          path: request.originalUrl,
          uid: request.user?.uid || null,
          email: request.user?.email || null,
          roles: request.user?.roles || [],
        }),
      );
      throw new ForbiddenException('Admin role required.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'admin_guard_allowed',
        path: request.originalUrl,
        uid: request.user?.uid,
        email: request.user?.email,
      }),
    );

    return true;
  }
}
