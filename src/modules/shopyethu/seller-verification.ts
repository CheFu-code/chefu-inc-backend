import type { SellerApplication } from './marketplace.types';

export function isVerifiedSeller(application: SellerApplication | null | undefined) {
  return Boolean(
    application?.status === 'approved' &&
    application.businessType === 'registered-business' &&
    application.cipcCertificateId &&
    application.cipcCertificateFormat,
  );
}
