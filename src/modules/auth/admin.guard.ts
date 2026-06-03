import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { auditRequestContext, hashForAudit } from '../../common/security-audit';
import { AuthenticatedUser } from './authenticated-user';
import { isAdmin } from './roles';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    if (!isAdmin(request.user)) {
      this.logger.warn(
        JSON.stringify({
          event: 'admin_guard_denied',
          ...auditRequestContext(request),
          uidHash: hashForAudit(request.user?.uid),
          emailHash: hashForAudit(request.user?.email),
          roles: request.user?.roles || [],
        }),
      );
      throw new ForbiddenException('Admin role required.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'admin_guard_allowed',
        ...auditRequestContext(request),
        uidHash: hashForAudit(request.user?.uid),
        emailHash: hashForAudit(request.user?.email),
      }),
    );

    return true;
  }
}
