import {
    Body,
    Controller,
    Get,
    HttpCode,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';

import { WhatsappService } from './whatsapp.service';
import { SendWhatsappOtpDto } from './dto/send-whatsapp-otp.dto';
import { VerifyWhatsappOtpDto } from './dto/verify-whatsapp-otp.dto';

@Controller()
export class WhatsappController {
    constructor(
        private readonly whatsappService: WhatsappService,
        private readonly configService: ConfigService,
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
    async verifyCode(
        @Body() dto: VerifyWhatsappOtpDto,
    ) {
        return this.whatsappService.verifyOtp(
            dto.phone,
            dto.code,
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
        const expectedToken =
            this.configService.get<string>(
                'WHATSAPP_VERIFY_TOKEN',
            );

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
    ) {
        this.whatsappService.processWebhook(
            payload,
        );

        /*
         * Always acknowledge the webhook quickly.
         *
         * Do heavy processing asynchronously if needed.
         */
        return {
            received: true,
        };
    }
}