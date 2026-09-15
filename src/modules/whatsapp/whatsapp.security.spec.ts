import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { Request } from 'express';

import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { WhatsappService } from './whatsapp.service';
import { generateOtp, hashOtp, verifyOtpHash } from './utils/otp.util';

void test('OTP utility generates six digits and verifies only the original code', () => {
  const otp = generateOtp();

  assert.match(otp, /^\d{6}$/);
  assert.equal(verifyOtpHash(otp, hashOtp(otp)), true);
  assert.equal(verifyOtpHash('000000', hashOtp(otp)), otp === '000000');
});

void test('WhatsApp webhook signature accepts the exact Meta payload signature', () => {
  const previousSecret = process.env.WHATSAPP_APP_SECRET;
  const secret = 'test-meta-app-secret';
  const rawBody = Buffer.from('{"entry":[]}');
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  const request = {
    rawBody,
    header(name: string) {
      return name === 'x-hub-signature-256' ? `sha256=${signature}` : undefined;
    },
  } as unknown as Request & { rawBody?: Buffer };
  const invalidRequest = {
    rawBody,
    header: () => `sha256=${'0'.repeat(64)}`,
  } as unknown as Request & { rawBody?: Buffer };

  process.env.WHATSAPP_APP_SECRET = secret;
  try {
    const service = new WhatsappService({} as FirebaseAdminService);
    assert.equal(service.isValidWebhookSignature(request), true);

    assert.equal(service.isValidWebhookSignature(invalidRequest), false);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.WHATSAPP_APP_SECRET;
    } else {
      process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  }
});
