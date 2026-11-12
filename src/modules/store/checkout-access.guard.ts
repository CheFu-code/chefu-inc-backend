import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { SESSION_COOKIE_NAME } from '../auth/session.constants';
import { CHECKOUT_COOKIE } from './checkout.validation';
import { RuntimeLimitService } from '../../common/runtime-limit.service';

export type CheckoutRequest = Request & { user?: AuthenticatedUser };
@Injectable()
export class CheckoutAccessGuard implements CanActivate {
  constructor(@Inject(AuthGuard) private readonly auth: AuthGuard, @Inject(RuntimeLimitService) private readonly limits: RuntimeLimitService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<CheckoutRequest>();
    const path = request.path.toLowerCase().replace(/\/+$/, '');
    const guest = request.cookies?.[CHECKOUT_COOKIE];
    const hasLogin = request.headers.authorization || request.cookies?.[SESSION_COOKIE_NAME];
    // Compatibility only: legacy verification may still authenticate with its original cookie.
    if (!hasLogin && path.endsWith('/verify') && typeof guest === 'string' && /^[a-f0-9]{64}$/.test(guest)) {
      request.user = undefined;
    } else {
      await this.auth.canActivate(context);
      if (!request.user) throw new UnauthorizedException('Sign in to continue checkout.');
    }
    const operation = path.split('/').at(-1);
    const result = await this.limits.reserve({ collection: 'runtime_store_limits', key: `${request.user?.uid ?? guest}:${operation}`, limit: operation === 'initialize' ? 15 : 60, windowMs: 15 * 60_000 });
    if (result.limited) throw new HttpException({ message: 'Please wait before checking checkout again.', retryAfterSeconds: result.retryAfterSeconds }, 429);
    return true;
  }
}
