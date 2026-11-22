import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { AdminRequest, UserManagementGuard } from "./user-management.guard";
import { UserManagementService } from "./user-management.service";
import { UpdateManagedUserDto } from "./user-management.dto";

@Controller("admin/user-management")
@UseGuards(AuthGuard, UserManagementGuard)
export class UserManagementController {
  constructor(private readonly service: UserManagementService) {}

  @Get("session")
  @Header("Cache-Control", "private, no-store")
  session(@Req() request: AdminRequest) {
    return this.service.session(request.user);
  }

  @Get("users")
  @Header("Cache-Control", "private, no-store")
  users(
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("search") search?: string,
  ) {
    return this.service.list({ limit, cursor, search });
  }

  @Get("summary")
  @Header("Cache-Control", "private, no-store")
  summary(@Query("days") days?: string) {
    return this.service.summary(days);
  }

  @Patch("users/:uid")
  @Header("Cache-Control", "private, no-store")
  update(
    @Param("uid") uid: string,
    @Body() body: UpdateManagedUserDto,
    @Req() request: AdminRequest,
  ) {
    return this.service.update(uid, body, request.user);
  }

  @Get("audit")
  @Header("Cache-Control", "private, no-store")
  audit(@Query("cursor") cursor?: string) {
    return this.service.audit(cursor);
  }
}
