import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import type { AppDatabase } from './database.js';

type AppOptions = {
  database: AppDatabase;
  webOrigin?: string;
};

const requestId: RequestHandler = (request, response, next) => {
  const id = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', id);
  next();
};

export function createApp({
  database,
  webOrigin = 'http://localhost:5173',
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: webOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({
      service: 'nomad-concierge-api',
      status: 'ok',
      database: database.ping() ? 'connected' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    void _next;
    console.error('Unhandled request error', error);
    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  };

  app.use(errorHandler);

  return app;
}
