import { Request } from 'express';

export type AcademySdkApiKey = {
  id: string;
  publicId?: string;
  plan?: string;
  ownerUid?: string;
  active?: boolean;
  name?: string;
  [key: string]: unknown;
};

export type AcademySdkRequest = Request & {
  apiKey?: AcademySdkApiKey;
};

export type AcademySdkUser = {
  uid: string;
  email?: string;
  roles?: string[];
};
