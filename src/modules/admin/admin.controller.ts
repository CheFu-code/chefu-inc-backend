import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    InternalServerErrorException,
    Logger,
    Param,
    Post,
    Patch,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { AdminAppsService } from './admin-apps.service';

type RequestWithUser = Request & {
    user?: AuthenticatedUser;
};

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
    private readonly logger = new Logger(AdminController.name);

    constructor(
        @Inject(FirebaseAdminService)
        private readonly firebaseAdmin: FirebaseAdminService,
        @Inject(AdminAppsService)
        private readonly adminApps: AdminAppsService,
    ) { }

    @Get('apps')
    apps() {
        return this.adminApps.listApps();
    }

    @Get('apps/muzalo/artist-requests')
    listMuzaloArtistRequests(@Query('status') status?: string) {
        return this.adminApps.listMuzaloArtistRequests(status);
    }

    @Patch('apps/muzalo/artist-requests/:email')
    reviewMuzaloArtistRequest(
        @Param('email') email: string,
        @Body() body: { reviewNote?: string; status?: string },
        @Req() request: RequestWithUser,
    ) {
        return this.adminApps.reviewMuzaloArtistRequest(
            email,
            body,
            request.user,
        );
    }

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

    @Patch('user-roles')
    async updateUserRoles(@Body() body: { email?: string; roles?: unknown }) {
        if (!body.email) {
            throw new BadRequestException('Email required.');
        }

        if (!Array.isArray(body.roles)) {
            throw new BadRequestException('Roles must be an array.');
        }

        const roles = Array.from(
            new Set(body.roles.map(role => String(role).trim().toLowerCase())),
        ).filter(Boolean);

        if (roles.length === 0) {
            throw new BadRequestException('At least one role is required.');
        }

        const userRef = this.firebaseAdmin.db().collection('users').doc(body.email);
        const snapshot = await userRef.get();

        if (!snapshot.exists) {
            throw new BadRequestException('User not found.');
        }

        const currentRoles = snapshot.data()?.roles;
        const hadAdmin =
            Array.isArray(currentRoles) &&
            currentRoles.some(role => String(role).toLowerCase() === 'admin');

        if (hadAdmin && !roles.includes('admin')) {
            throw new BadRequestException('Admin role cannot be removed.');
        }

        await userRef.update({
            roles,
            updatedAt: new Date(),
        });

        this.logger.warn(
            JSON.stringify({
                event: 'admin_user_roles_updated',
                email: body.email,
                roles,
            }),
        );

        return { success: true, roles };
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
