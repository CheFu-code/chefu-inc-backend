import { requestFlyIdentityToken } from '../dist/modules/cloudence/google-play-federation.js';

// Run inside the deployed Fly Machine after building. Never print the JWT.
try {
  const token = await requestFlyIdentityToken('cloudence-billing-setup');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  console.log(JSON.stringify({
    issuer: claims.iss,
    org_id: claims.org_id,
    org_name: claims.org_name,
    app_id: claims.app_id,
    app_name: claims.app_name,
  }, null, 2));
} catch {
  console.error('Could not read Fly workload identity. Run this inside a Fly Machine after npm run build.');
  process.exitCode = 1;
}
