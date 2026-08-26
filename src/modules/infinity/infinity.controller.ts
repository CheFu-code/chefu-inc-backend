import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { InfinityService } from './infinity.service';
import { SaveInfinityHistoryPayload } from './infinity.types';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('infinity')
@UseGuards(AuthGuard)
export class InfinityController {
    constructor(private readonly infinityService: InfinityService) { }

    @Get('history')
    getState(@Req() request: AuthenticatedRequest) {
        return this.infinityService.getState(request.user);
    }

    @Put('history')
    saveState(
        @Req() request: AuthenticatedRequest,
        @Body() body: SaveInfinityHistoryPayload,
    ) {
        return this.infinityService.saveState(request.user, body.state);
    }
}