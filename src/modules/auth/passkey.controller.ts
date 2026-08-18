import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Logger,
    Param,
    Post,
    Req,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
    type AuthenticationResponseJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AuthGuard } from './auth.guard';
import { AuthenticatedUser } from './authenticated-user';
import { PasskeyService } from './passkey.service';

@Controller('auth/passkey')
export class PasskeyController {
    private readonly logger = new Logger(PasskeyController.name);

    constructor(private readonly passkey: PasskeyService) { }

    @Post('register/options')
    @UseGuards(AuthGuard)
    @HttpCode(200)
    async createRegistrationOptions(
        @Req() request: Request & { user?: AuthenticatedUser },
    ) {
        const user = request.user;

        if (!user?.uid || !user?.email) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        const clientKey = this.getClientIp(request) || 'unknown';

        return this.passkey.createRegistrationOptions(
            { uid: user.uid, email: user.email },
            clientKey,
        );
    }

    @Post('register/verify')
    @UseGuards(AuthGuard)
    @HttpCode(200)
    async verifyRegistration(
        @Req() request: Request & { user?: AuthenticatedUser },
        @Body()
        body: {
            challengeId?: string;
            response?: RegistrationResponseJSON;
        },
    ) {
        const user = request.user;

        if (!user?.uid || !user?.email) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        const clientKey = this.getClientIp(request) || 'unknown';

        return this.passkey.verifyRegistration(
            { uid: user.uid, email: user.email },
            clientKey,
            body,
        );
    }

    @Post('authenticate/options')
    @HttpCode(200)
    async createAuthenticationOptions(@Req() request: Request) {
        const clientKey = this.getClientIp(request) || 'unknown';

        return this.passkey.createAuthenticationOptions(clientKey);
    }

    @Post('authenticate/verify')
    @HttpCode(200)
    async verifyAuthentication(
        @Req() request: Request,
        @Body()
        body: {
            challengeId?: string;
            response?: AuthenticationResponseJSON;
        },
    ) {
        const clientKey = this.getClientIp(request) || 'unknown';

        const result = await this.passkey.verifyAuthentication(clientKey, body);

        return result;
    }

    @Get('credentials')
    @UseGuards(AuthGuard)
    async listCredentials(
        @Req() request: Request & { user?: AuthenticatedUser },
    ) {
        const user = request.user;

        if (!user?.uid) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        return this.passkey.listCredentials(user.uid);
    }

    @Delete('credentials/:credentialId')
    @UseGuards(AuthGuard)
    async deleteCredential(
        @Req() request: Request & { user?: AuthenticatedUser },
        @Param('credentialId') credentialId: string,
    ) {
        const user = request.user;

        if (!user?.uid) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        return this.passkey.deleteCredential(user.uid, credentialId);
    }

    private getClientIp(request: Request) {
        const forwardedFor = request.headers['x-forwarded-for'];
        const firstForwardedIp = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : forwardedFor?.split(',')[0];

        return firstForwardedIp?.trim() || request.ip || undefined;
    }
}
