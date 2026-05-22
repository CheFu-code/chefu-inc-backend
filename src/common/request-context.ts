import { Request } from 'express';

export type RequestWithId = Request & {
  requestId?: string;
};

export function getRequestId(request: Request) {
  return (request as RequestWithId).requestId || 'unknown';
}
