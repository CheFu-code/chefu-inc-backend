import test from 'node:test';
import assert from 'node:assert/strict';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Request, Response } from 'express';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import {
  captureFlowInboundRawBody,
  configureCors,
  createCookieCsrfMiddleware,
  createSecurityHeadersMiddleware,
} from './http-security';

const allowedOrigins = ['https://myaccount.chefu.co.za'];

@Module({})
class HttpSecurityTestModule {}

async function startTestServer(trustedProxyAddresses: string[] = []) {
  const app = await NestFactory.create<NestExpressApplication>(
    HttpSecurityTestModule,
    { bodyParser: false, logger: false },
  );
  app.set('trust proxy', trustedProxyAddresses);
  configureCors(app, allowedOrigins);
  app.use(
    express.json({
      verify: captureFlowInboundRawBody,
    }),
  );
  app.use(cookieParser());
  app.use(createSecurityHeadersMiddleware());
  app.use(createCookieCsrfMiddleware(allowedOrigins));
  app.use((request: Request, response: Response) => {
    response.json({
      ip: request.ip,
      rawBodyCaptured: Boolean(
        (request as typeof request & { rawBody?: Buffer }).rawBody,
      ),
    });
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    await app.close();
    throw new Error('Test server did not bind to a TCP port.');
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

void test('HTTP security middleware enforces CORS and cookie CSRF while preserving API clients', async () => {
  const server = await startTestServer();
  try {
    const preflight = await fetch(`${server.baseUrl}/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigins[0],
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigins[0]);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

    const allowedCookieMutation = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Origin: allowedOrigins[0],
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(allowedCookieMutation.status, 200);
    assert.equal(
      allowedCookieMutation.headers.get('x-content-type-options'),
      'nosniff',
    );
    assert.match(
      allowedCookieMutation.headers.get('content-security-policy') || '',
      /frame-ancestors 'self'/,
    );

    const missingOriginCookieMutation = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(missingOriginCookieMutation.status, 403);

    const untrustedOrigin = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        Cookie: '__session=test-session',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(untrustedOrigin.headers.get('access-control-allow-origin'), null);

    const bearerClient = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer api-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(bearerClient.status, 200);

    const rawBodyResponse = await fetch(`${server.baseUrl}/flow/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"signed":"payload"}',
    });
    assert.equal(rawBodyResponse.status, 200);
    assert.deepEqual(await rawBodyResponse.json(), {
      ip: '127.0.0.1',
      rawBodyCaptured: true,
    });

    const ordinaryBodyResponse = await fetch(`${server.baseUrl}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ordinary":"payload"}',
    });
    assert.equal(ordinaryBodyResponse.status, 200);
    assert.deepEqual(await ordinaryBodyResponse.json(), {
      ip: '127.0.0.1',
      rawBodyCaptured: false,
    });

    const spoofedForwardingHeader = await fetch(`${server.baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '198.51.100.25' },
    });
    assert.deepEqual(await spoofedForwardingHeader.json(), {
      ip: '127.0.0.1',
      rawBodyCaptured: false,
    });
  } finally {
    await server.app.close();
  }
});

void test('proxy forwarding headers are honored only when the peer is explicitly trusted', async () => {
  const trustedProxy = await startTestServer(['127.0.0.1']);
  try {
    const response = await fetch(`${trustedProxy.baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '198.51.100.25' },
    });
    assert.deepEqual(await response.json(), {
      ip: '198.51.100.25',
      rawBodyCaptured: false,
    });
  } finally {
    await trustedProxy.app.close();
  }
});
