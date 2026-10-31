import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler, Router } from 'express';
import type { AppDatabase } from './db/database.js';

export interface AppOptions { database: AppDatabase; webOrigins?: string[]; router?: Router; errorHandler?: ErrorRequestHandler; webDistPath?: string }
const requestId: RequestHandler = (request, response, next) => {
  response.locals.requestId = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', response.locals.requestId as string);
  next();
};
export function createApp({ database, webOrigins = ['http://localhost:5173'], router, errorHandler, webDistPath }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: webOrigins, credentials: true }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.get('/api/health', (_request, response) => {
    response.json({ service: 'nomad-concierge-api', status: 'ok', database: database.ping() ? 'connected' : 'unavailable', timestamp: new Date().toISOString() });
  });
  if (router) app.use(router);
  if (webDistPath) {
    const files = express.static(webDistPath);
    app.use((request, response, next) => {
      const reserved = ['/api', '/ws'].some(prefix => request.path === prefix || request.path.startsWith(`${prefix}/`));
      if (reserved) { next(); return; }
      files(request, response, (error?: unknown) => {
        if (error) { next(error); return; }
        if (request.method !== 'GET') { next(); return; }
        response.sendFile(join(webDistPath, 'index.html'), next);
      });
    });
  }
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: response.locals.requestId } });
  });
  const defaultErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    void next;
    const invalidJson = error instanceof SyntaxError && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed';
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    if (!invalidJson && !tooLarge) console.error('Unhandled request error', { requestId: response.locals.requestId, error });
    response.status(invalidJson || tooLarge ? 400 : 500).json({ error: { code: invalidJson || tooLarge ? 'BAD_REQUEST' : 'INTERNAL_ERROR', message: invalidJson || tooLarge ? 'Invalid request body.' : 'An unexpected error occurred.', requestId: response.locals.requestId } });
  };
  app.use(errorHandler ?? defaultErrorHandler);
  return app;
}
