export interface MissingVariable {
  name: string;
  description?: string;
  alternatives?: string[];
}

export interface ServiceEnvGroup {
  service: string;
  missing: MissingVariable[];
}

export class ConfigurationError extends Error {
  public readonly groups: ServiceEnvGroup[];
  public readonly isConfigurationError = true;

  constructor(message: string, groups: ServiceEnvGroup[] = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.groups = groups;
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }

  static formatErrorMessage(groups: ServiceEnvGroup[]): string {
    const totalMissing = groups.reduce((acc, g) => acc + g.missing.length, 0);

    if (totalMissing === 0) {
      return 'Configuration Error: An unknown configuration issue occurred.';
    }

    if (groups.length === 1 && groups[0].missing.length === 1) {
      const item = groups[0].missing[0];
      const desc = item.description ? ` (${item.description})` : '';
      const alt = item.alternatives?.length
        ? ` or alternative(s): ${item.alternatives.join(', ')}`
        : '';
      return `Configuration Error: ${item.name}${desc} is not configured.${alt} Please add it to your environment variables and restart the application.`;
    }

    const lines: string[] = [
      'Configuration Error: The following required environment variables are missing:\n',
    ];

    for (const group of groups) {
      if (group.missing.length === 0) continue;
      lines.push(`${group.service}:`);
      for (const item of group.missing) {
        const desc = item.description ? ` (${item.description})` : '';
        const alt = item.alternatives?.length
          ? ` [or ${item.alternatives.join(' / ')}]`
          : '';
        lines.push(`  * ${item.name}${desc}${alt}`);
      }
      lines.push('');
    }

    lines.push('Please configure the required environment variables and restart the application.');
    return lines.join('\n').trim();
  }

  static fromGroups(groups: ServiceEnvGroup[]): ConfigurationError {
    const nonNullGroups = groups.filter(g => g.missing.length > 0);
    const message = this.formatErrorMessage(nonNullGroups);
    return new ConfigurationError(message, nonNullGroups);
  }

  static fromSingle(
    service: string,
    variableName: string,
    description?: string,
    alternatives?: string[],
  ): ConfigurationError {
    return this.fromGroups([
      {
        service,
        missing: [{ name: variableName, description, alternatives }],
      },
    ]);
  }
}

function getEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[name] || '').trim();
}

function hasEnv(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return getEnv(name, env).length > 0;
}

function hasAnyEnv(names: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return names.some(n => hasEnv(n, env));
}

// ── Service-Specific Validators ──

export function validateFirebaseAdminEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];

  const hasServiceAccount = hasEnv('FIREBASE_SERVICE_ACCOUNT', env);
  const hasProjectId = hasAnyEnv(['FIREBASE_PROJECT_ID', 'FIREBASE_ADMIN_PROJECT_ID'], env);
  const hasClientEmail = hasAnyEnv(['FIREBASE_CLIENT_EMAIL', 'FIREBASE_ADMIN_CLIENT_EMAIL'], env);
  const hasPrivateKey = hasAnyEnv(['FIREBASE_PRIVATE_KEY', 'FIREBASE_ADMIN_PRIVATE_KEY'], env);

  if (!hasServiceAccount && (!hasProjectId || !hasClientEmail || !hasPrivateKey)) {
    if (!hasProjectId) {
      missing.push({
        name: 'FIREBASE_PROJECT_ID',
        description: 'Firebase Project ID',
        alternatives: ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_ADMIN_PROJECT_ID'],
      });
    }
    if (!hasClientEmail) {
      missing.push({
        name: 'FIREBASE_CLIENT_EMAIL',
        description: 'Firebase Client Service Email',
        alternatives: ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_ADMIN_CLIENT_EMAIL'],
      });
    }
    if (!hasPrivateKey) {
      missing.push({
        name: 'FIREBASE_PRIVATE_KEY',
        description: 'Firebase Admin Private Key (RSA PEM format)',
        alternatives: ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_ADMIN_PRIVATE_KEY'],
      });
    }
  }

  return { service: 'Firebase Admin', missing };
}

export function validateCloudinaryEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];
  if (!hasEnv('CLOUDINARY_CLOUD_NAME', env)) {
    missing.push({ name: 'CLOUDINARY_CLOUD_NAME', description: 'Cloudinary Cloud Name' });
  }
  if (!hasEnv('CLOUDINARY_API_KEY', env)) {
    missing.push({ name: 'CLOUDINARY_API_KEY', description: 'Cloudinary API Key' });
  }
  if (!hasEnv('CLOUDINARY_API_SECRET', env)) {
    missing.push({ name: 'CLOUDINARY_API_SECRET', description: 'Cloudinary API Secret' });
  }
  return { service: 'Cloudinary Media Storage', missing };
}

export function validatePayFastEnv(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = env.NODE_ENV === 'production',
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];

  if (!hasEnv('PAYFAST_MERCHANT_ID', env)) {
    missing.push({ name: 'PAYFAST_MERCHANT_ID', description: 'PayFast Merchant ID' });
  }
  if (!hasEnv('PAYFAST_MERCHANT_KEY', env)) {
    missing.push({ name: 'PAYFAST_MERCHANT_KEY', description: 'PayFast Merchant Key' });
  }
  // In production, PayFast passphrase is required for secure signature and ITN verification
  if (isProduction && !hasEnv('PAYFAST_PASSPHRASE', env)) {
    missing.push({
      name: 'PAYFAST_PASSPHRASE',
      description: 'PayFast Salt Passphrase for secure payment validation',
    });
  }

  return { service: 'PayFast Payment Gateway', missing };
}

export function validateClerkEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];
  if (!hasEnv('CLERK_WEBHOOK_SECRET', env)) {
    missing.push({ name: 'CLERK_WEBHOOK_SECRET', description: 'Clerk Webhook Signing Secret' });
  }
  return { service: 'Clerk Billing', missing };
}

export function validateResendEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];
  if (!hasEnv('RESEND_API_KEY', env)) {
    missing.push({ name: 'RESEND_API_KEY', description: 'Resend API Key for Email Delivery' });
  }
  return { service: 'Resend Email Service', missing };
}

export function validateGeminiEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];
  if (!hasEnv('GEMINI_API_KEY', env)) {
    missing.push({ name: 'GEMINI_API_KEY', description: 'Google Gemini AI API Key' });
  }
  return { service: 'Gemini AI Service', missing };
}

export function validateWhatsAppEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceEnvGroup {
  const missing: MissingVariable[] = [];
  if (!hasEnv('WHATSAPP_PHONE_NUMBER_ID', env)) {
    missing.push({ name: 'WHATSAPP_PHONE_NUMBER_ID', description: 'WhatsApp Business Phone Number ID' });
  }
  if (!hasEnv('WHATSAPP_SYSTEM_USER_TOKEN', env)) {
    missing.push({ name: 'WHATSAPP_SYSTEM_USER_TOKEN', description: 'WhatsApp Meta Graph System Token' });
  }
  return { service: 'WhatsApp Cloud API', missing };
}

// ── Bootstrap & Production Validator ──

export interface BackendEnvValidationResult {
  isValid: boolean;
  isProduction: boolean;
  groups: ServiceEnvGroup[];
  allMissing: string[];
  error?: ConfigurationError;
}

export function validateBackendEnv(
  env: NodeJS.ProcessEnv = process.env,
): BackendEnvValidationResult {
  const isProduction = env.NODE_ENV === 'production';
  const groups: ServiceEnvGroup[] = [];

  // Core / Server group
  const coreMissing: MissingVariable[] = [];
  if (isProduction && !hasAnyEnv(['FRONTEND_ORIGINS', 'FRONTEND_ORIGIN'], env)) {
    coreMissing.push({
      name: 'FRONTEND_ORIGINS',
      description: 'Allowed CORS origin URLs (comma-separated)',
      alternatives: ['FRONTEND_ORIGIN'],
    });
  }
  if (coreMissing.length > 0) {
    groups.push({ service: 'Core Server / CORS', missing: coreMissing });
  }

  // Auth & Session group
  const authMissing: MissingVariable[] = [];
  const hasSessionSecret = hasAnyEnv(['AUTH_SESSION_SECRET', 'SESSION_COOKIE_SECRET'], env);
  if (!hasSessionSecret && isProduction) {
    authMissing.push({
      name: 'AUTH_SESSION_SECRET',
      description: 'Session signing secret (min 32 characters)',
      alternatives: ['SESSION_COOKIE_SECRET'],
    });
  } else if (hasSessionSecret) {
    const secret = getEnv('AUTH_SESSION_SECRET', env) || getEnv('SESSION_COOKIE_SECRET', env);
    if (secret.length < 32 && isProduction) {
      authMissing.push({
        name: 'AUTH_SESSION_SECRET',
        description: 'Session signing secret is too short (must be at least 32 characters for security)',
      });
    }
  }
  if (isProduction && !hasEnv('CHEFU_ACCOUNT_URL', env)) {
    authMissing.push({
      name: 'CHEFU_ACCOUNT_URL',
      description: 'CheFu Account frontend URL',
    });
  }
  if (authMissing.length > 0) {
    groups.push({ service: 'Authentication & Session', missing: authMissing });
  }

  // OAuth & OIDC Server group
  const oauthMissing: MissingVariable[] = [];
  if (isProduction) {
    if (!hasEnv('OAUTH_ISSUER', env)) {
      oauthMissing.push({ name: 'OAUTH_ISSUER', description: 'OAuth2/OIDC Issuer URL (e.g. https://api.chefu.co.za)' });
    }
    if (!hasEnv('OAUTH_KEY_ID', env)) {
      oauthMissing.push({ name: 'OAUTH_KEY_ID', description: 'OAuth2 Signing Key ID (kid)' });
    }
    if (!hasAnyEnv(['OAUTH_PRIVATE_KEY', 'OAUTH_SIGNING_KEYS_JSON'], env)) {
      oauthMissing.push({
        name: 'OAUTH_PRIVATE_KEY',
        description: 'RSA Private Key in PEM format for signing RS256 JWT tokens',
        alternatives: ['OAUTH_SIGNING_KEYS_JSON'],
      });
    }
  }
  if (oauthMissing.length > 0) {
    groups.push({ service: 'OAuth2 / OIDC Server', missing: oauthMissing });
  }

  // Firebase Admin group
  const firebaseGroup = validateFirebaseAdminEnv(env);
  if (firebaseGroup.missing.length > 0) {
    // In development or production, Firebase Admin is required for user auth and DB
    groups.push(firebaseGroup);
  }

  // Flow Access group (required in production)
  const flowMissing: MissingVariable[] = [];
  if (isProduction && !hasEnv('FLOW_ACCESS_SECRET', env)) {
    flowMissing.push({
      name: 'FLOW_ACCESS_SECRET',
      description: 'Secret key for signing and verifying Flow access tokens',
    });
  }
  if (flowMissing.length > 0) {
    groups.push({ service: 'Flow Mail Service', missing: flowMissing });
  }

  const allMissing = groups.flatMap(g => g.missing.map(m => m.name));
  const isValid = groups.length === 0;
  const error = isValid ? undefined : ConfigurationError.fromGroups(groups);

  return {
    isValid,
    isProduction,
    groups,
    allMissing,
    error,
  };
}

// Ensure legacy export compatibility while delegating to the new centralized validator
export function validateProductionEnv(): { missing: string[] } {
  const result = validateBackendEnv();
  return { missing: result.allMissing };
}

// ── Assertion Helpers ──

export function assertServiceConfigured(group: ServiceEnvGroup): void {
  if (group.missing.length > 0) {
    throw ConfigurationError.fromGroups([group]);
  }
}

export function assertResendConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validateResendEnv(env));
}

export function assertCloudinaryConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validateCloudinaryEnv(env));
}

export function assertPayFastConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validatePayFastEnv(env));
}

export function assertGeminiConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validateGeminiEnv(env));
}

export function assertWhatsAppConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validateWhatsAppEnv(env));
}

export function assertClerkConfigured(env: NodeJS.ProcessEnv = process.env): void {
  assertServiceConfigured(validateClerkEnv(env));
}
