import { Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigurationError } from './env/env';

type R2Configuration = {
  bucket: string;
  client: S3Client;
};

function isRangeNotSatisfiable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    record.name === 'InvalidRange' ||
    record.$metadata?.httpStatusCode === 416
  );
}

@Injectable()
export class CloudflareR2StorageService {
  private client?: S3Client;

  private configuration(): R2Configuration {
    const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim();
    const bucket = process.env.CLOUDFLARE_R2_BUCKET?.trim();
    const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
    const service = 'Cloudflare R2 fallback storage';
    if (!accountId)
      throw ConfigurationError.fromSingle(service, 'CLOUDFLARE_R2_ACCOUNT_ID');
    if (!bucket)
      throw ConfigurationError.fromSingle(service, 'CLOUDFLARE_R2_BUCKET');
    if (!accessKeyId)
      throw ConfigurationError.fromSingle(service, 'CLOUDFLARE_R2_ACCESS_KEY_ID');
    if (!secretAccessKey)
      throw ConfigurationError.fromSingle(service, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY');

    this.client ??= new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });

    return { bucket, client: this.client };
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string,
    sha256: string,
  ): Promise<void> {
    const { bucket, client } = this.configuration();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'private, no-store',
        Metadata: { sha256 },
      }),
    );
  }

  async openContent(
    key: string,
    options: { range?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const { bucket, client } = this.configuration();
    let result: GetObjectCommandOutput;
    try {
      result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(options.range ? { Range: options.range } : {}),
        }),
        { abortSignal: options.signal },
      );
    } catch (error) {
      if (!options.range || !isRangeNotSatisfiable(error)) throw error;
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: options.signal },
      );
      const headers = new Headers({ 'Accept-Ranges': 'bytes' });
      if (head.ContentLength !== undefined) {
        headers.set('Content-Range', `bytes */${head.ContentLength}`);
      }
      return new Response(null, { status: 416, headers });
    }
    if (!result.Body) {
      throw new Error('Cloudflare R2 returned an empty object body.');
    }

    const headers = new Headers({ 'Accept-Ranges': 'bytes' });
    if (result.ContentType) headers.set('Content-Type', result.ContentType);
    if (result.ContentLength !== undefined) {
      headers.set('Content-Length', String(result.ContentLength));
    }
    if (result.ContentRange) headers.set('Content-Range', result.ContentRange);

    return new Response(result.Body.transformToWebStream(), {
      status: result.ContentRange ? 206 : 200,
      headers,
    });
  }

  async delete(key: string): Promise<void> {
    const { bucket, client } = this.configuration();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
