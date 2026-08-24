import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import {
  AlertDto,
  IngestLogDto,
  LogixService,
  ProjectConfigDto,
  QueryLogsDto,
} from './logix.service';

@Controller('logix')
export class LogixController {
  constructor(private readonly logixService: LogixService) {}

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  @Get('overview')
  @UseGuards(AuthGuard)
  async getOverview(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.getOverview(request.user);
  }

  // ---------------------------------------------------------------------------
  // Logs Query & Ingestion
  // ---------------------------------------------------------------------------

  @Get('logs')
  @UseGuards(AuthGuard)
  async queryLogs(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Query() query: QueryLogsDto,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.queryLogs(request.user, query);
  }

  @Post('logs')
  async ingestLog(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Headers('x-api-key') apiKeyHeader: string | undefined,
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: IngestLogDto,
  ) {
    const rawApiKey =
      apiKeyHeader ||
      (authHeader?.startsWith('Bearer chf_')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined);

    if (rawApiKey) {
      return this.logixService.ingestLogWithApiKey(rawApiKey, body);
    }

    if (request.user) {
      return this.logixService.ingestLog(request.user, body);
    }

    throw new UnauthorizedException(
      'Authentication session or valid API key required for log ingestion.',
    );
  }

  @Post('ingest')
  async ingestLogAlias(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Headers('x-api-key') apiKeyHeader: string | undefined,
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: IngestLogDto,
  ) {
    return this.ingestLog(request, apiKeyHeader, authHeader, body);
  }

  // ---------------------------------------------------------------------------
  // API Keys
  // ---------------------------------------------------------------------------

  @Get('api-keys')
  @UseGuards(AuthGuard)
  async listApiKeys(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.listApiKeys(request.user);
  }

  @Post('api-keys')
  @UseGuards(AuthGuard)
  async createApiKey(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body()
    body: {
      name?: string;
      scope?: 'Full Access' | 'Read Only' | 'Write Only';
      expiresAt?: string;
    },
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.createApiKey(request.user, body);
  }

  @Post('api-keys/:id/revoke')
  @UseGuards(AuthGuard)
  async revokeApiKey(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Param('id') id: string,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.revokeApiKey(request.user, id);
  }

  @Delete('api-keys/:id')
  @UseGuards(AuthGuard)
  async deleteApiKey(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Param('id') id: string,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.deleteApiKey(request.user, id);
  }

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  @Get('alerts')
  @UseGuards(AuthGuard)
  async listAlerts(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.listAlerts(request.user);
  }

  @Post('alerts')
  @UseGuards(AuthGuard)
  async createAlert(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: AlertDto,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.createAlert(request.user, body);
  }

  @Delete('alerts/:id')
  @UseGuards(AuthGuard)
  async deleteAlert(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Param('id') id: string,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.deleteAlert(request.user, id);
  }

  // ---------------------------------------------------------------------------
  // Project Settings & Billing
  // ---------------------------------------------------------------------------

  @Get('project')
  @UseGuards(AuthGuard)
  async getProject(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.getProjectSettings(request.user);
  }

  @Patch('project')
  @UseGuards(AuthGuard)
  async updateProject(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: ProjectConfigDto,
  ) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.updateProjectSettings(request.user, body);
  }

  @Get('billing')
  @UseGuards(AuthGuard)
  async getBilling(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.getBillingInfo(request.user);
  }

  // ---------------------------------------------------------------------------
  // Danger Zone / Account Deletion
  // ---------------------------------------------------------------------------

  @Delete('account')
  @UseGuards(AuthGuard)
  async deleteAccount(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user required.');
    }
    return this.logixService.requestAccountDeletion(request.user);
  }
}
