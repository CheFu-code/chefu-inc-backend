import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from './authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { ADMIN_ROLE } from './roles';
import { readAuthUserProfile } from './auth-user-profile';

export type ShopYethuRequest = Request & {
  user?: AuthenticatedUser;
  shopyethuAccount?: { uid: string; email: string; name: string };
};

// Run after AuthGuard. Always re-read roles; signed session metadata can outlive
// administrator access removed from the central user profile.
@Injectable()
export class ShopYethuAdminGuard implements CanActivate {
  constructor(@Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ShopYethuRequest>();
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('CheFu sign-in required.');
    const profile = await readAuthUserProfile(this.firebase, user.email, request);
    const roles = Array.isArray(profile.roles) ? profile.roles.filter((role: unknown): role is string => typeof role === 'string') : [];
    if (!roles.some(role => role.trim().toLowerCase() === ADMIN_ROLE)) {
      throw new ForbiddenException('ShopYethu administrator access required.');
    }
    request.user = { ...user, roles };
    request.shopyethuAccount = {
      uid: user.uid, email: user.email,
      name: typeof profile.fullname === 'string' && profile.fullname ? profile.fullname : user.email,
    };
    return true;
  }
}
