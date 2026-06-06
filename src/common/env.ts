type EnvValidationResult = {
  invalid: string[];
  missing: string[];
};

function hasAnyEnv(names: string[]) {
  return names.some(name => Boolean(process.env[name]?.trim()));
}

function hasEnvWithMinLength(name: string, minLength: number) {
  return (process.env[name]?.trim().length || 0) >= minLength;
}

export function validateProductionEnv(): EnvValidationResult {
  if (process.env.NODE_ENV !== 'production') {
    return { invalid: [], missing: [] };
  }

  const invalid: string[] = [];
  const missing: string[] = [];

  if (!hasAnyEnv(['AUTH_SESSION_SECRET', 'SESSION_COOKIE_SECRET'])) {
    missing.push('AUTH_SESSION_SECRET or SESSION_COOKIE_SECRET');
  }

  if (
    hasAnyEnv(['AUTH_SESSION_SECRET']) &&
    !hasEnvWithMinLength('AUTH_SESSION_SECRET', 32)
  ) {
    missing.push('AUTH_SESSION_SECRET with at least 32 characters');
  }

  if (
    !hasAnyEnv(['AUTH_SESSION_SECRET']) &&
    hasAnyEnv(['SESSION_COOKIE_SECRET']) &&
    !hasEnvWithMinLength('SESSION_COOKIE_SECRET', 32)
  ) {
    missing.push('SESSION_COOKIE_SECRET with at least 32 characters');
  }

  if (
    !hasAnyEnv(['FIREBASE_SERVICE_ACCOUNT']) &&
    !(
      hasAnyEnv(['FIREBASE_PROJECT_ID']) &&
      hasAnyEnv(['FIREBASE_CLIENT_EMAIL']) &&
      hasAnyEnv(['FIREBASE_PRIVATE_KEY'])
    )
  ) {
    missing.push(
      'FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY',
    );
  }

  if (!hasAnyEnv(['FRONTEND_ORIGINS', 'FRONTEND_ORIGIN'])) {
    missing.push('FRONTEND_ORIGINS or FRONTEND_ORIGIN');
  } else if (!hasOnlyHttpsUrls(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN)) {
    invalid.push('FRONTEND_ORIGINS/FRONTEND_ORIGIN must contain only HTTPS origins');
  }

  for (const name of ['CHEFU_ACCOUNT_URL', 'OAUTH_ISSUER', 'OAUTH_KEY_ID']) {
    if (!hasAnyEnv([name])) {
      missing.push(name);
    }
  }

  for (const name of ['CHEFU_ACCOUNT_URL', 'OAUTH_ISSUER']) {
    if (hasAnyEnv([name]) && !isHttpsUrl(process.env[name])) {
      invalid.push(`${name} must be an HTTPS URL`);
    }
  }

  if (!hasAnyEnv(['OAUTH_PRIVATE_KEY', 'OAUTH_SIGNING_KEYS_JSON'])) {
    missing.push('OAUTH_PRIVATE_KEY or OAUTH_SIGNING_KEYS_JSON');
  }

  if (!hasAnyEnv(['FLOW_ACCESS_SECRET'])) {
    missing.push('FLOW_ACCESS_SECRET');
  } else if (
    !hasEnvWithMinLength('FLOW_ACCESS_SECRET', 32) ||
    process.env.FLOW_ACCESS_SECRET === 'flow-local-development-secret'
  ) {
    invalid.push('FLOW_ACCESS_SECRET must be a non-default secret with at least 32 characters');
  }

  return { invalid, missing };
}

function hasOnlyHttpsUrls(value: string | undefined) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .every(isHttpsUrl);
}

function isHttpsUrl(value: string | undefined) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}
