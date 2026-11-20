import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { AuthenticatedUser } from "../auth/authenticated-user";
import { CloudenceNotificationsService } from "./cloudence-notifications.service";

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Controller("cloudence/notifications")
@UseGuards(AuthGuard)
export class CloudenceNotificationsController {
  constructor(private readonly notifications: CloudenceNotificationsService) {}

  @Get("preferences")
  getPreferences(@Req() request: AuthenticatedRequest) {
    return this.notifications.getPreferences(this.requireUser(request).uid);
  }

  @Put("device")
  registerDevice(
    @Req() request: AuthenticatedRequest,
    @Body() body: { expoPushToken?: unknown; platform?: unknown },
  ) {
    const token =
      typeof body?.expoPushToken === "string" ? body.expoPushToken.trim() : "";
    if (!/^(Expo|Exponent)PushToken\[[\w-]+\]$/.test(token)) {
      throw new BadRequestException("A valid Expo push token is required.");
    }
    const platform =
      body.platform === "ios" || body.platform === "android"
        ? body.platform
        : "unknown";
    return this.notifications.registerDevice(
      this.requireUser(request).uid,
      token,
      platform,
    );
  }

  @Delete("device")
  removeDevice(
    @Req() request: AuthenticatedRequest,
    @Body() body: { expoPushToken?: unknown },
  ) {
    const token =
      typeof body?.expoPushToken === "string" ? body.expoPushToken.trim() : "";
    if (!/^(Expo|Exponent)PushToken\[[\w-]+\]$/.test(token)) {
      throw new BadRequestException("A valid Expo push token is required.");
    }
    return this.notifications.removeDevice(
      this.requireUser(request).uid,
      token,
    );
  }

  @Put("preferences")
  updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body()
    body: {
      quotaAlertsEnabled?: unknown;
      collaboratorActivityEnabled?: unknown;
    },
  ) {
    if (
      typeof body?.quotaAlertsEnabled !== "boolean" ||
      typeof body?.collaboratorActivityEnabled !== "boolean"
    ) {
      throw new BadRequestException(
        "Both notification preferences must be boolean values.",
      );
    }
    return this.notifications.updatePreferences(this.requireUser(request).uid, {
      quotaAlertsEnabled: body.quotaAlertsEnabled,
      collaboratorActivityEnabled: body.collaboratorActivityEnabled,
    });
  }

  private requireUser(request: AuthenticatedRequest) {
    if (!request.user)
      throw new UnauthorizedException(
        "Authenticated user missing from request.",
      );
    return request.user;
  }
}
