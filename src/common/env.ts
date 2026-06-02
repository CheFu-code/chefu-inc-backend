type EnvValidationResult = {
  missing: string[];
};

function hasAnyEnv(names: string[]) {
  return names.some(name => Boolean(process.env[name]?.trim()));
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

  if (!hasAnyEnv(['FLOW_ACCESS_SECRET'])) {
    missing.push('FLOW_ACCESS_SECRET');
  }

  return { missing };
}
