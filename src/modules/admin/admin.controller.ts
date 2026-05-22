import {
  BadRequestException,
  Body,
  Controller,
  InternalServerErrorException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  @Post('delete-user')
  async deleteUser(@Body() body: { uid?: string; email?: string }) {
    if (!body.uid) {
      throw new BadRequestException('UID required.');
    }
    if (!body.email) {
      throw new BadRequestException('Email required.');
    }

    this.logger.warn(
      JSON.stringify({
        event: 'admin_delete_user_started',
        uid: body.uid,
        email: body.email,
      }),
    );

    await this.firebaseAdmin.auth().deleteUser(body.uid);
    await this.firebaseAdmin.db().collection('users').doc(body.email).delete();

    this.logger.warn(
      JSON.stringify({
        event: 'admin_delete_user_succeeded',
        uid: body.uid,
        email: body.email,
      }),
    );

    return { success: true };
  }

  @Post('send-otp')
  async sendOtp(@Body() body: { phone?: string }) {
    if (!body.phone) {
      throw new BadRequestException('Phone required.');
    }

    const to = this.normalizePhone(body.phone);
    if (!to) {
      throw new BadRequestException(
        'Invalid phone format. Use country code plus number.',
      );
    }

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_SYSTEM_USER_TOKEN;

    if (!phoneNumberId || !token) {
      throw new InternalServerErrorException('Missing WhatsApp env vars.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'admin_otp_send_started',
        phoneLast4: to.slice(-4),
      }),
    );

    const response = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: 'hello_world',
            language: {
              code: 'en_US',
            },
          },
        }),
      },
    );

    const data = (await response.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
    };

    if (!response.ok) {
      this.logger.error(
        JSON.stringify({
          event: 'admin_otp_send_failed',
          statusCode: response.status,
          details: data,
        }),
      );
      throw new InternalServerErrorException({
        error: 'Failed to send OTP template',
        details: data,
      });
    }

    this.logger.log(
      JSON.stringify({
        event: 'admin_otp_send_succeeded',
        messageId: data.messages?.[0]?.id || null,
      }),
    );

    return {
      success: true,
      messageId: data.messages?.[0]?.id,
    };
  }

  private normalizePhone(input: string) {
    const digits = input.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
  }
}
