import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_META_COOKIE_NAME,
  SessionMeta,
} from './session.constants';
import { SessionSignerService } from './session-signer.service';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly otpAttempts = new Map<string, number[]>();

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly sessionSigner: SessionSignerService,
  ) {}

  @Post('session')
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';

    if (!idToken) {
      throw new UnauthorizedException('Missing Firebase ID token.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'auth_session_create_started',
        requestId: request.headers['x-request-id'] || null,
        hasBearerToken: Boolean(idToken),
      }),
    );

    let decodedToken: Awaited<
      ReturnType<ReturnType<FirebaseAdminService['auth']>['verifyIdToken']>
    >;
    let sessionCookie: string;

    try {
      decodedToken = await this.firebaseAdmin.auth().verifyIdToken(idToken);
      const expiresIn = SESSION_MAX_AGE_SECONDS * 1000;
      sessionCookie = await this.firebaseAdmin
        .auth()
        .createSessionCookie(idToken, { expiresIn });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'auth_session_create_failed',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw new UnauthorizedException('Failed to verify Firebase session.');
    }

    const roles = await this.getUserRoles(decodedToken.email);
    const meta: SessionMeta = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      roles,
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
    };

    response.cookie(SESSION_COOKIE_NAME, sessionCookie, this.getCookieOptions());
    response.cookie(
      SESSION_META_COOKIE_NAME,
      this.sessionSigner.sign(meta),
      this.getCookieOptions(),
    );

    this.logger.log(
      JSON.stringify({
        event: 'auth_session_created',
        uid: decodedToken.uid,
        email: decodedToken.email || null,
        roleCount: roles.length,
      }),
    );

    return { ok: true };
  }

  @Post('send-otp')
  async sendOtp(@Body() body: { phone?: string }, @Req() request: Request) {
    if (!body.phone) {
      throw new BadRequestException('Phone required.');
    }

    const to = this.normalizePhone(body.phone);
    if (!to) {
      throw new BadRequestException(
        'Invalid phone format. Use country code plus number.',
      );
    }

    this.enforceOtpThrottle(request.ip || 'unknown');
    this.logger.log(
      JSON.stringify({
        event: 'otp_send_started',
        ip: request.ip,
        phoneLast4: to.slice(-4),
      }),
    );

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_SYSTEM_USER_TOKEN;

    if (!phoneNumberId || !token) {
      throw new InternalServerErrorException('Missing WhatsApp env vars.');
    }

    const upstream = await fetch(
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

    const data = (await upstream.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
    };

    if (!upstream.ok) {
      this.logger.error(
        JSON.stringify({
          event: 'otp_send_failed',
          statusCode: upstream.status,
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
        event: 'otp_send_succeeded',
        messageId: data.messages?.[0]?.id || null,
      }),
    );

    return {
      success: true,
      messageId: data.messages?.[0]?.id,
    };
  }

  @Delete('session')
  @HttpCode(200)
  clearSession(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE_NAME, this.getClearCookieOptions());
    response.clearCookie(SESSION_META_COOKIE_NAME, this.getClearCookieOptions());
    this.logger.log(JSON.stringify({ event: 'auth_session_cleared' }));
    return { ok: true };
  }

  private getCookieOptions() {
    const cookieDomain =
      process.env.NODE_ENV === 'production'
        ? process.env.AUTH_COOKIE_DOMAIN || undefined
        : undefined;

    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      domain: cookieDomain,
      maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    };
  }

  private getClearCookieOptions() {
    const cookieDomain =
      process.env.NODE_ENV === 'production'
        ? process.env.AUTH_COOKIE_DOMAIN || undefined
        : undefined;

    return {
      path: '/',
      domain: cookieDomain,
    };
  }

  private async getUserRoles(email?: string) {
    if (!email) return [];

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .get();

    const roles = snapshot.data()?.roles;
    return Array.isArray(roles) ? roles.map(String) : [];
  }

  private normalizePhone(input: string) {
    const digits = input.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
  }

  private enforceOtpThrottle(ip: string) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxAttempts = 5;
    const recentAttempts = (this.otpAttempts.get(ip) || []).filter(
      timestamp => now - timestamp < windowMs,
    );

    if (recentAttempts.length >= maxAttempts) {
      throw new BadRequestException('Too many OTP requests. Try again later.');
    }

    recentAttempts.push(now);
    this.otpAttempts.set(ip, recentAttempts);
  }
}
