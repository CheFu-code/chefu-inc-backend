type EnvValidationResult = {
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
    return { missing: [] };
  }

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
  }

  for (const name of ['CHEFU_ACCOUNT_URL', 'OAUTH_ISSUER', 'OAUTH_KEY_ID']) {
    if (!hasAnyEnv([name])) {
      missing.push(name);
    }
  }

  if (!hasAnyEnv(['OAUTH_PRIVATE_KEY'])) {
    missing.push('OAUTH_PRIVATE_KEY');
  }

  if (!hasAnyEnv(['FLOW_ACCESS_SECRET'])) {
    missing.push('FLOW_ACCESS_SECRET');
  }

  return { missing };
}
