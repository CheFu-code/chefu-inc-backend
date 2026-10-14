import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';

/** Run after authentication and before Multer reads the multipart body. */
@Injectable()
export class CloudenceUploadGuard implements CanActivate {
  private readonly activeUsers = new Map<string, number>();
  private activeUploads = 0;
  constructor(private readonly runtimeLimits: RuntimeLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) throw new UnauthorizedException('Authentication required.');
    const response = http.getResponse<Response>();
    const uid = request.user.uid;
    if ((this.activeUsers.get(uid) || 0) >= 3 || this.activeUploads >= 6) {
      response.setHeader('Retry-After', '1');
      throw new HttpException('Uploads are busy. Please wait before uploading more files.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.activeUsers.set(uid, (this.activeUsers.get(uid) || 0) + 1);
    this.activeUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeUploads--;
      const remaining = (this.activeUsers.get(uid) || 1) - 1;
      if (remaining) this.activeUsers.set(uid, remaining); else this.activeUsers.delete(uid);
    };
    response.once('finish', release);
    response.once('close', release);
    try {
      const limit = await this.runtimeLimits.reserve({
        collection: 'cloudence_upload_limits', key: uid, limit: 15, windowMs: 60_000,
      });
      if (limit.limited) {
        response.setHeader('Retry-After', String(limit.retryAfterSeconds));
        throw new HttpException('Upload rate limit reached. Please wait a minute before uploading more files.', HttpStatus.TOO_MANY_REQUESTS);
      }
      return true;
    } catch (error) {
      release();
      throw error;
    }
  }
}
