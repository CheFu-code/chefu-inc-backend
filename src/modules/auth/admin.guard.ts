import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from './authenticated-user';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const isAdmin = request.user?.roles.some(
      role => role.toLowerCase() === 'admin',
    );

    if (!isAdmin) {
      throw new ForbiddenException('Admin role required.');
    }

    return true;
  }
}
