import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  HttpCode,
  UnauthorizedException,
  Req,
  Res,
  Query,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Webhook } from 'svix';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { SESSION_COOKIE_NAME } from '../auth/session.constants';
import { FLOW_ACCESS_DENIED_MESSAGE } from './flow-access';
import {
  FlowAccessKeyService,
  FlowAccessPermission,
} from './flow-access-key.service';
import { FlowSendPayload } from './flow-email.types';
import { FlowService } from './flow.service';

@Controller('flow')
export class FlowController {
  constructor(
    @Inject(FlowService)
    private readonly flowService: FlowService,
    @Inject(FlowAccessKeyService)
    private readonly flowAccessKeys: FlowAccessKeyService,
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  @Get('access/session')
  async accessSession(@Req() request: Request) {
    return this.flowAccessKeys.sessionPayload(
      await this.flowAccessKeys.sessionFromRequest(request),
    );
  }

  @Post('access/login')
  async accessLogin(
    @Body() body: { accessKey?: string; code?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.flowAccessKeys.login(
      body.code || body.accessKey || '',
      response,
      request,
    );
  }

  @Post('access/activate')
  async accessActivate(
    @Body() body: { accessKey?: string; code?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.flowAccessKeys.login(
      body.accessKey || body.code || '',
      response,
      request,
    );
  }

  @Get('admin/access-keys')
  @UseGuards(AuthGuard, AdminGuard)
  async listAccessKeys() {
    return this.flowAccessKeys.listKeys();
  }

  @Post('admin/access-keys')
  @UseGuards(AuthGuard, AdminGuard)
  async createAccessKey(
    @Body() body: { expiresAt?: string; label?: string; permission?: string },
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    return this.flowAccessKeys.createKey(body, request.user);
  }

  @Post('admin/access-keys/:keyId/revoke')
  @UseGuards(AuthGuard, AdminGuard)
  async revokeAccessKey(
    @Param('keyId') keyId: string,
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    return this.flowAccessKeys.revokeKey(keyId, request.user);
  }

  // ── Allowed emails & senders ──────────────────────────────────────────

  @Get('allowed-emails')
  async getAllowedEmails(
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');
    return this.flowService.listAllowedEmails();
  }

  @Post('allowed-emails')
  async createAllowedEmail(
    @Body() body: { email?: string; name?: string },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request & { user?: AuthenticatedUser },
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    const session = request ? await this.flowAccessKeys.sessionFromRequest(request) : null;
    const addedBy =
      request?.user?.email ||
      request?.user?.uid ||
      session?.label ||
      'Flow Session';

    return this.flowService.addAllowedEmail(
      body.email || '',
      body.name || null,
      addedBy,
    );
  }

  @Delete('allowed-emails/:email')
  async deleteAllowedEmail(
    @Param('email') email: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.removeAllowedEmail(email);
  }

  @Get('admin/allowed-emails')
  @UseGuards(AuthGuard, AdminGuard)
  async listAllowedEmails() {
    return this.flowService.listAllowedEmails();
  }

  @Post('admin/allowed-emails')
  @UseGuards(AuthGuard, AdminGuard)
  async addAllowedEmail(
    @Body() body: { email?: string; name?: string },
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    return this.flowService.addAllowedEmail(
      body.email || '',
      body.name || null,
      request.user?.email || request.user?.uid || null,
    );
  }

  @Delete('admin/allowed-emails/:email')
  @UseGuards(AuthGuard, AdminGuard)
  async removeAllowedEmail(@Param('email') email: string) {
    return this.flowService.removeAllowedEmail(email);
  }

  @Delete('access/session')
  @HttpCode(200)
  clearAccessSession(@Res({ passthrough: true }) response: Response) {
    return this.flowAccessKeys.clearSession(response);
  }

  @Get('config')
  async getConfig(
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');
    return this.flowService.getConfig();
  }

  @Get('messages')
  async messages(
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
    @Query('folder') folder?: string,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');
    return this.flowService.getMessages(folder);
  }

  @Get('messages/stream')
  async messageStream(
    @Headers('x-flow-api-key') flowApiKey: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
    @Query('folder') folder?: string,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const writeEvent = (event: string, payload: unknown) => {
      if (response.writableEnded) return;
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (response.writableEnded) return;
      response.write(': keepalive\n\n');
    }, 25_000);
    const unsubscribe = this.flowService.watchMessages(
      folder,
      payload => writeEvent('messages', payload),
      error => {
        writeEvent('error', {
          message:
            error instanceof Error
              ? error.message
              : 'Flow message stream failed.',
        });
      },
    );

    writeEvent('ready', { ok: true });

    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!response.writableEnded) response.end();
    });
  }

  @Get('messages/:messageId/attachments')
  async attachments(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');
    return this.flowService.listAttachments(messageId);
  }

  @Get('messages/:messageId/attachments/:attachmentId')
  async attachment(
    @Param('messageId') messageId: string,
    @Param('attachmentId') attachmentId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'read');
    return this.flowService.getAttachment(messageId, attachmentId);
  }

  @Post('messages/:messageId/read')
  async markRead(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.markRead(messageId);
  }

  @Post('messages/:messageId/unread')
  async markUnread(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.markUnread(messageId);
  }

  @Post('messages/:messageId/star')
  async star(
    @Param('messageId') messageId: string,
    @Body() body: { starred?: boolean },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.setStarred(messageId, Boolean(body.starred));
  }

  @Post('messages/:messageId/archive')
  async archive(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.moveToFolder(messageId, 'archived');
  }

  @Post('messages/:messageId/report')
  async report(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.reportMessage(messageId);
  }

  @Post('messages/:messageId/folder')
  async moveToFolder(
    @Param('messageId') messageId: string,
    @Body() body: { folder?: string },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.moveToFolder(messageId, body.folder || 'inbox');
  }

  @Post('messages/:messageId/trash')
  async trash(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.moveToTrash(messageId);
  }

  @Delete('messages/:messageId')
  async remove(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.deleteMessage(messageId);
  }

  @Post('drafts')
  async saveDraft(
    @Body()
    body: {
      body?: string;
      from?: string;
      subject?: string;
      to?: string | string[];
    },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request, 'write');
    return this.flowService.saveDraft(body);
  }

  @Post('send')
  async send(
    @Body() body: FlowSendPayload,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.send(body);
  }

  @Post('inbound')
  inbound(
    @Body() body: unknown,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Headers('x-flow-webhook-secret') webhookSecret?: string,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ) {
    const payload = this.verifyInboundPayload(body, request, {
      flowApiKey,
      svixId,
      svixSignature,
      svixTimestamp,
      webhookSecret,
    });

    return this.flowService.receiveInbound(payload);
  }

  private assertFlowApiKey(flowApiKey?: string) {
    const requiredKey = process.env.FLOW_API_KEY;
    if (!requiredKey) return;

    if (flowApiKey !== requiredKey) {
      throw new ForbiddenException('Invalid Flow API key.');
    }
  }

  private async assertFlowAccess(
    flowApiKey?: string,
    request?: Request,
    requiredPermission: FlowAccessPermission = 'full',
  ) {
    const requiredKey = process.env.FLOW_API_KEY;
    const isBrowserRequest = Boolean(request?.headers.origin);

    if (!isBrowserRequest && requiredKey && flowApiKey === requiredKey) {
      return;
    }

    if (request) {
      const session = await this.flowAccessKeys.sessionFromRequest(request);
      if (session && this.hasPermission(session.permission, requiredPermission)) {
        return;
      }
      if (session) {
        throw new ForbiddenException('This Flow access key does not have permission for this action.');
      }
    }

    const sessionCookie = request?.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionCookie) {
      throw new UnauthorizedException('Authentication required.');
    }

    try {
      const decodedToken = await this.firebaseAdmin
        .auth()
        .verifySessionCookie(sessionCookie, true);

      if (!(await this.flowService.isAllowedFlowUser(decodedToken.email))) {
        throw new ForbiddenException(FLOW_ACCESS_DENIED_MESSAGE);
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new UnauthorizedException('Authentication required.');
    }
  }

  private hasPermission(
    grantedPermission: FlowAccessPermission,
    requiredPermission: FlowAccessPermission,
  ) {
    return (
      grantedPermission === 'full' ||
      grantedPermission === requiredPermission
    );
  }

  private assertInboundSecret(flowApiKey?: string, webhookSecret?: string) {
    const requiredWebhookSecret = process.env.FLOW_INBOUND_SECRET;
    if (requiredWebhookSecret) {
      if (webhookSecret !== requiredWebhookSecret) {
        throw new ForbiddenException('Invalid Flow inbound secret.');
      }
      return;
    }

    this.assertFlowApiKey(flowApiKey);
  }

  private verifyInboundPayload(
    body: unknown,
    request: Request & { rawBody?: Buffer },
    headers: {
      flowApiKey?: string;
      svixId?: string;
      svixSignature?: string;
      svixTimestamp?: string;
      webhookSecret?: string;
    },
  ) {
    const resendWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;

    if (!resendWebhookSecret) {
      this.assertInboundSecret(headers.flowApiKey, headers.webhookSecret);
      return body;
    }

    if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
      throw new ForbiddenException('Missing Resend webhook signature headers.');
    }

    try {
      const rawBody = request.rawBody?.toString('utf8') || JSON.stringify(body);
      return new Webhook(resendWebhookSecret).verify(rawBody, {
        'svix-id': headers.svixId,
        'svix-signature': headers.svixSignature,
        'svix-timestamp': headers.svixTimestamp,
      });
    } catch {
      throw new ForbiddenException('Invalid Resend webhook signature.');
    }
  }
}
