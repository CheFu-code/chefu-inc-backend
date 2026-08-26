import {
    Body,
    Controller,
    Get,
    Headers,
    Post,
    Query,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { IngestLogDto, LogixService, QueryLogsDto } from './logix.service';

@Controller('logs')
export class LogixCompatController {
    constructor(private readonly logixService: LogixService) { }

    @Get()
    @UseGuards(AuthGuard)
    async queryLogs(
        @Req() request: Request & { user?: AuthenticatedUser },
        @Query() query: QueryLogsDto,
    ) {
        if (!request.user) throw new UnauthorizedException('Authenticated user required.');
        return this.logixService.queryLogs(request.user, query);
    }

    @Get('stream')
    @UseGuards(AuthGuard)
    async streamLogs(
        @Req() request: Request & { user?: AuthenticatedUser },
        @Query() query: QueryLogsDto,
        @Res() response: Response,
    ) {
        if (!request.user) throw new UnauthorizedException('Authenticated user required.');
        return this.logixService.streamLogs(request.user, query, request, response);
    }

    @Post('send')
    async sendLogs(
        @Headers('x-api-key') apiKey: string | undefined,
        @Body() body: { logs?: IngestLogDto[] },
    ) {
        if (!apiKey) throw new UnauthorizedException('API key required.');
        const logs = Array.isArray(body.logs) ? body.logs : [];
        for (const log of logs) {
            await this.logixService.ingestLogWithApiKey(apiKey, log);
        }
        return { success: true, count: logs.length };
    }
}