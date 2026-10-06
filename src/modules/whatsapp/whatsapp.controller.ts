import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Post,
    Query,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { WhatsappService } from './whatsapp.service';
import { SendWhatsappOtpDto } from './dto/send-whatsapp-otp.dto';
import { VerifyWhatsappOtpDto } from './dto/verify-whatsapp-otp.dto';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';

@Controller()
export class WhatsappController {
    constructor(
        private readonly whatsappService: WhatsappService,
    ) { }

    /**
     * Request WhatsApp OTP.
     *
     * POST /auth/whatsapp/send-code
     */
    @Post('auth/whatsapp/send-code')
    @HttpCode(200)
    async sendCode(
        @Body() dto: SendWhatsappOtpDto,
    ) {
        return this.whatsappService.sendOtp(
            dto.phone,
        );
    }

    /**
     * Verify WhatsApp OTP.
     *
     * POST /auth/whatsapp/verify-code
     */
    @Post('auth/whatsapp/verify-code')
    @HttpCode(200)
    @UseGuards(AuthGuard)
    async verifyCode(
        @Body() dto: VerifyWhatsappOtpDto,
        @Req() request: Request & { user?: AuthenticatedUser },
    ) {
        if (!request.user) {
            throw new UnauthorizedException('Authentication required.');
        }

        return this.whatsappService.verifyOtp(
            dto.phone,
            dto.code,
            request.user.uid,
        );
    }

    @Post('auth/whatsapp/login/start')
    @HttpCode(200)
    async startLoginVerification(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: { phone?: string },
    ) {
        const idToken = this.readBearerToken(authorization);
        return this.whatsappService.startLoginVerification(idToken, body.phone);
    }

    @Post('auth/whatsapp/login/verify')
    @HttpCode(200)
    async verifyLoginVerification(
        @Headers('authorization') authorization: string | undefined,
        @Body() body: { phone?: string; code?: string },
    ) {
        const idToken = this.readBearerToken(authorization);
        if (!body.phone || !body.code) {
            throw new UnauthorizedException('Phone number and verification code are required.');
        }

        return this.whatsappService.verifyLoginVerification(
            idToken,
            body.phone,
            body.code,
        );
    }

    /**
     * Meta webhook verification.
     *
     * GET /webhooks/whatsapp
     */
    @Get('webhooks/whatsapp')
    verifyWebhook(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') verifyToken: string,
        @Query('hub.challenge') challenge: string,
        @Res() response: Response,
    ) {
        const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim();

        if (
            mode === 'subscribe' &&
            verifyToken &&
            expectedToken &&
            verifyToken === expectedToken
        ) {
            return response
                .status(200)
                .send(challenge);
        }

        return response
            .status(403)
            .send('Forbidden');
    }

    /**
     * Receive Meta webhook events.
     *
     * POST /webhooks/whatsapp
     */
    @Post('webhooks/whatsapp')
    @HttpCode(200)
    async webhook(
        @Body() payload: any,
        @Req() request: Request & { rawBody?: Buffer },
        @Res() response: Response,
    ) {
        if (!this.whatsappService.isValidWebhookSignature(request)) {
            return response.status(403).send('Forbidden');
        }

        this.whatsappService.processWebhook(payload);

        /*
         * Always acknowledge the webhook quickly.
         *
         * Do heavy processing asynchronously if needed.
         */
        return response.status(200).json({ received: true });
    }

    private readBearerToken(authorization: string | undefined): string {
        if (!authorization?.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing Firebase ID token.');
        }

        return authorization.slice('Bearer '.length).trim();
    }
}