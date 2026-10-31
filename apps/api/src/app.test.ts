import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { AppDatabase } from './db/database.js';

describe('API foundation', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
  });

  afterEach(() => {
    database.close();
  });

  it('reports API and database health', async () => {
    const response = await request(createApp({ database })).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: 'nomad-concierge-api',
      status: 'ok',
      database: 'connected',
    });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('returns a structured response for unknown routes', async () => {
    const response = await request(createApp({ database })).get('/api/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
  });
});

