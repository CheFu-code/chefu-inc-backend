import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedUser } from "../auth/authenticated-user";
import { readAuthUserProfile } from "../auth/auth-user-profile";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";

export type AdminRequest = Request & { user: AuthenticatedUser };

@Injectable()
export class UserManagementGuard implements CanActivate {
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebase: FirebaseAdminService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!request.user?.uid || !request.user.email)
      throw new UnauthorizedException("CheFu sign-in required.");
    // Session metadata and OAuth claims can outlive an administrator's access.
    const [profile, account] = await Promise.all([
      readAuthUserProfile(this.firebase, request.user.email, request),
      this.firebase.auth().getUser(request.user.uid),
    ]);
    const roles = Array.isArray(profile.roles)
      ? profile.roles.filter((role): role is string => typeof role === "string")
      : [];
    if (
      account.disabled ||
      !roles.some((role) => role.trim().toLowerCase() === "admin")
    ) {
      throw new ForbiddenException("CheFu administrator access required.");
    }
    request.user = { ...request.user, roles };
    return true;
  }
}
