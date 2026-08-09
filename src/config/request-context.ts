import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { isAllowedOrigin } from './origin';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestContext(allowedOrigins: string[], allowPrivateLan: boolean) {
  return (request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header('x-request-id');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    response.setHeader('X-Request-ID', requestId);

    const origin = request.header('origin');
    if (!isAllowedOrigin(origin, allowedOrigins, { allowPrivateLan })) {
      response.status(403).json({
        statusCode: 403,
        message: 'This origin is not allowed.',
        requestId,
      });
      return;
    }

    const startedAt = Date.now();
    response.on('finish', () => {
      console.log(JSON.stringify({
        requestId,
        method: request.method,
        path: request.originalUrl?.split('?')[0],
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    });
    next();
  };
}
