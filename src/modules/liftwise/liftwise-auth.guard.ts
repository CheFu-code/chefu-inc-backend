import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedUser } from "../auth/authenticated-user";
import { OAuthService } from "../auth/oauth.service";

export type LiftWiseRequest = Request & { user: AuthenticatedUser };

@Injectable()
export class LiftWiseAuthGuard implements CanActivate {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<LiftWiseRequest>();
    const authorization = request.headers.authorization || "";
    if (!authorization.startsWith("Bearer ") || !authorization.slice(7).trim())
      throw new UnauthorizedException("CheFu sign-in required.");
    const claims = await this.oauth.verifyAccessToken(
      authorization.slice(7),
      request,
    );
    if (
      claims.typ !== "access_token" ||
      claims.app !== "liftwise" ||
      !claims.sub ||
      claims.sub.includes("/")
    )
      throw new UnauthorizedException("A LiftWise access token is required.");
    request.user = {
      uid: claims.sub,
      email: claims.email || "",
      roles: claims.roles || [],
    };
    return true;
  }
}
