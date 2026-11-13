import { BadRequestException, CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { OAuthService } from '../auth/oauth.service';
import type { Actor } from './marketplace.types';

export type MarketplaceRequest = Request & { user: Actor };
@Injectable()
export class MarketplaceAuthGuard implements CanActivate {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}
  async canActivate(context: ExecutionContext) {
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    const request = context.switchToHttp().getRequest<MarketplaceRequest>();
    if (['POST', 'PUT'].includes(request.method) && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))) throw new BadRequestException('A valid request body is required.');
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) throw new UnauthorizedException('Sign in with your CheFu account.');
    const claims = await this.oauth.verifyAccessToken(authorization.slice(7), request);
    if (claims.typ !== 'access_token' || claims.app !== 'shopyethu' || !claims.sub || !claims.email || /[/\\]/.test(claims.sub)) throw new UnauthorizedException('A ShopYethu sign-in is required.');
    request.user = { uid: claims.sub, email: claims.email || '', roles: [] };
    return true;
  }
}
