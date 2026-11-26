export type GooglePlayFederationConfig = {
  audience: string;
  serviceAccountEmail: string;
};

const PROVIDER_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9]\d*\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT_EMAIL = /^[a-zA-Z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

export function googlePlayFederationIssues(env: NodeJS.ProcessEnv) {
  const issues: Array<{ name: string; description: string }> = [];
  if (!PROVIDER_AUDIENCE.test(env.GOOGLE_PLAY_WIF_AUDIENCE?.trim() ?? '')) {
    issues.push({
      name: 'GOOGLE_PLAY_WIF_AUDIENCE',
      description: 'Full provider audience: //iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID',
    });
  }
  if (!SERVICE_ACCOUNT_EMAIL.test(env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?.trim() ?? '')) {
    issues.push({
      name: 'GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL',
      description: 'Google Play billing service account email ending in .iam.gserviceaccount.com',
    });
  }
  return issues;
}

export function readGooglePlayFederationConfig(
  env: NodeJS.ProcessEnv = process.env,
): GooglePlayFederationConfig | null {
  if (googlePlayFederationIssues(env).length) return null;
  return {
    audience: env.GOOGLE_PLAY_WIF_AUDIENCE!.trim(),
    serviceAccountEmail: env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL!.trim(),
  };
}
