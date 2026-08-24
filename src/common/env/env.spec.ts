import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigurationError,
  validateBackendEnv,
  validateFirebaseAdminEnv,
  validateCloudinaryEnv,
  validatePayFastEnv,
  validateClerkEnv,
  validateResendEnv,
  validateGeminiEnv,
  validateWhatsAppEnv,
  assertCloudinaryConfigured,
  assertResendConfigured,
  assertGeminiConfigured,
  assertWhatsAppConfigured,
  assertPayFastConfigured,
  assertClerkConfigured,
} from './env';

const VALID_DEV_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  FIREBASE_PROJECT_ID: 'chefu-test-project',
  FIREBASE_CLIENT_EMAIL: 'test@chefu-test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----',
};

const VALID_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  FRONTEND_ORIGINS: 'https://chefu.co.za,https://myaccount.chefu.co.za',
  AUTH_SESSION_SECRET: 'a_very_long_secure_session_secret_for_signing_tokens_1234567890',
  CHEFU_ACCOUNT_URL: 'https://myaccount.chefu.co.za',
  OAUTH_ISSUER: 'https://api.chefu.co.za',
  OAUTH_KEY_ID: 'chefu-oauth-prod-key-2026',
  OAUTH_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----',
  FIREBASE_PROJECT_ID: 'chefu-prod-project',
  FIREBASE_CLIENT_EMAIL: 'prod@chefu-prod-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----',
  FLOW_ACCESS_SECRET: 'flow_access_secret_production_key_1234567890',
};

test('validateBackendEnv passes when all required development variables are provided', () => {
  const result = validateBackendEnv(VALID_DEV_ENV);
  assert.equal(result.isValid, true);
  assert.equal(result.allMissing.length, 0);
  assert.equal(result.error, undefined);
});

test('validateBackendEnv passes when all required production variables are provided', () => {
  const result = validateBackendEnv(VALID_PROD_ENV);
  assert.equal(result.isValid, true);
  assert.equal(result.allMissing.length, 0);
  assert.equal(result.error, undefined);
});

test('validateBackendEnv supports FIREBASE_SERVICE_ACCOUNT alternative in production', () => {
  const customEnv: NodeJS.ProcessEnv = {
    ...VALID_PROD_ENV,
    FIREBASE_PROJECT_ID: '',
    FIREBASE_CLIENT_EMAIL: '',
    FIREBASE_PRIVATE_KEY: '',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: 'chefu-prod-project',
      client_email: 'prod@chefu-prod-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6\n-----END PRIVATE KEY-----',
    }),
  };
  const result = validateBackendEnv(customEnv);
  assert.equal(result.isValid, true);
  assert.equal(result.allMissing.length, 0);
});

test('validateBackendEnv fails clearly when a single variable is missing', () => {
  const invalidEnv: NodeJS.ProcessEnv = {
    ...VALID_PROD_ENV,
    CHEFU_ACCOUNT_URL: '',
  };
  const result = validateBackendEnv(invalidEnv);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.allMissing, ['CHEFU_ACCOUNT_URL']);
  assert.ok(result.error instanceof ConfigurationError);
  assert.match(
    result.error.message,
    /Configuration Error: CHEFU_ACCOUNT_URL/i,
  );
  assert.match(
    result.error.message,
    /Please add it to your environment variables and restart the application\./i,
  );
});

test('validateBackendEnv fails and groups all missing variables when multiple are missing', () => {
  const invalidEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    // Missing all required production vars
  };
  const result = validateBackendEnv(invalidEnv);
  assert.equal(result.isValid, false);
  assert.ok(result.allMissing.length >= 5);
  assert.ok(result.error instanceof ConfigurationError);

  const msg = result.error.message;
  assert.match(msg, /Configuration Error: The following required environment variables are missing:/);
  assert.match(msg, /Core Server \/ CORS:/);
  assert.match(msg, /Authentication & Session:/);
  assert.match(msg, /OAuth2 \/ OIDC Server:/);
  assert.match(msg, /Firebase Admin:/);
  assert.match(msg, /Flow Mail Service:/);
  assert.match(msg, /FRONTEND_ORIGINS/);
  assert.match(msg, /AUTH_SESSION_SECRET/);
  assert.match(msg, /OAUTH_ISSUER/);
  assert.match(msg, /FIREBASE_PROJECT_ID/);
  assert.match(msg, /FLOW_ACCESS_SECRET/);
});

test('validateBackendEnv rejects short AUTH_SESSION_SECRET in production', () => {
  const invalidEnv: NodeJS.ProcessEnv = {
    ...VALID_PROD_ENV,
    AUTH_SESSION_SECRET: 'short_secret',
  };
  const result = validateBackendEnv(invalidEnv);
  assert.equal(result.isValid, false);
  assert.ok(result.allMissing.includes('AUTH_SESSION_SECRET'));
  assert.match(result.error!.message, /at least 32 characters/);
});

test('validateCloudinaryEnv and assertCloudinaryConfigured identify missing Cloudinary keys', () => {
  const emptyEnv: NodeJS.ProcessEnv = {};
  const group = validateCloudinaryEnv(emptyEnv);
  assert.equal(group.missing.length, 3);
  assert.deepEqual(
    group.missing.map(m => m.name),
    ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  );

  assert.throws(
    () => assertCloudinaryConfigured(emptyEnv),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /CLOUDINARY_CLOUD_NAME/);
      assert.match((err as Error).message, /CLOUDINARY_API_KEY/);
      assert.match((err as Error).message, /CLOUDINARY_API_SECRET/);
      return true;
    },
  );

  const validCloudinaryEnv: NodeJS.ProcessEnv = {
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: '1234567890',
    CLOUDINARY_API_SECRET: 'test_secret_key',
  };
  assert.doesNotThrow(() => assertCloudinaryConfigured(validCloudinaryEnv));
});

test('validatePayFastEnv identifies missing keys in development and production', () => {
  const devEnv: NodeJS.ProcessEnv = {
    PAYFAST_MERCHANT_ID: '10000100',
    PAYFAST_MERCHANT_KEY: '46f0cd694581a',
  };
  const devGroup = validatePayFastEnv(devEnv, false);
  assert.equal(devGroup.missing.length, 0);

  // In production, passphrase is required
  const prodGroup = validatePayFastEnv(devEnv, true);
  assert.equal(prodGroup.missing.length, 1);
  assert.equal(prodGroup.missing[0].name, 'PAYFAST_PASSPHRASE');

  const fullProdEnv: NodeJS.ProcessEnv = {
    ...devEnv,
    PAYFAST_PASSPHRASE: 'secure_salt_passphrase',
  };
  assert.doesNotThrow(() => assertPayFastConfigured(fullProdEnv));
});

test('validateResendEnv and assertResendConfigured identify missing RESEND_API_KEY', () => {
  assert.throws(
    () => assertResendConfigured({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /RESEND_API_KEY/);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertResendConfigured({ RESEND_API_KEY: 're_test_123456789' }),
  );
});

test('validateGeminiEnv and assertGeminiConfigured identify missing GEMINI_API_KEY', () => {
  assert.throws(
    () => assertGeminiConfigured({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /GEMINI_API_KEY/);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertGeminiConfigured({ GEMINI_API_KEY: 'AIzaSy_fake_test_key_123' }),
  );
});

test('validateWhatsAppEnv and assertWhatsAppConfigured identify missing WhatsApp variables', () => {
  assert.throws(
    () => assertWhatsAppConfigured({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /WHATSAPP_PHONE_NUMBER_ID/);
      assert.match((err as Error).message, /WHATSAPP_SYSTEM_USER_TOKEN/);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertWhatsAppConfigured({
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
      WHATSAPP_SYSTEM_USER_TOKEN: 'EAAB_token_123',
    }),
  );
});

test('validateClerkEnv and assertClerkConfigured identify missing Clerk webhook secret', () => {
  assert.throws(
    () => assertClerkConfigured({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match((err as Error).message, /CLERK_WEBHOOK_SECRET/);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertClerkConfigured({ CLERK_WEBHOOK_SECRET: 'whsec_test_123' }),
  );
});

test('Error messages never leak secret token contents', () => {
  const secretValue = 'super_secret_raw_token_xyz_never_leak';
  const customEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    AUTH_SESSION_SECRET: secretValue.slice(0, 10), // too short
  };
  const result = validateBackendEnv(customEnv);
  assert.equal(result.isValid, false);
  const msg = result.error!.message;
  assert.equal(msg.includes(secretValue), false);
  assert.equal(msg.includes(secretValue.slice(0, 10)), false);
});
