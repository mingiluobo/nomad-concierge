import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { closeHttpServer, listenOnLoopback } from '../helpers/http.js';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AppDatabase } from '../../src/db/database.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
async function fixture(enabled = true, onError?: (error: unknown) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'nc-static-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new AppDatabase(join(directory, 'app.sqlite'));
  cleanup.push(() => database.close());
  const webDistPath = join(directory, 'web');
  mkdirSync(join(webDistPath, 'assets'), { recursive: true });
  mkdirSync(join(webDistPath, 'api'), { recursive: true });
  writeFileSync(join(webDistPath, 'index.html'), '<!doctype html><title>Nomad fixture</title>');
  writeFileSync(join(webDistPath, 'assets', 'app.js'), 'window.nomad = true;');
  writeFileSync(join(webDistPath, 'api', 'unexpected'), 'This file must not shadow the API.');
  const app = createApp({ database, webDistPath: enabled ? webDistPath : undefined,
    errorHandler: onError ? (error: unknown, _request, response, next) => {
      void next;
      onError(error);
      if (!response.headersSent) response.status(500).end();
    } : undefined });
  const server = await listenOnLoopback(app);
  cleanup.push(() => closeHttpServer(server));
  return server;
}
describe('production static web serving', () => {
  it('serves assets and the SPA for direct navigation to conversation and plan routes', async () => {
    const app = await fixture();
    for (const path of ['/', '/login', '/c/a-conversation', '/plans/a-plan']) {
      const response = await request(app).get(path).expect(200).expect('Content-Type', /html/);
      expect(response.text).toContain('<title>Nomad fixture</title>');
    }
    const asset = await request(app).get('/assets/app.js').expect(200).expect('Content-Type', /javascript/);
    expect(asset.text).toBe('window.nomad = true;');
  });
  it('keeps API and WebSocket paths out of static serving and the SPA fallback', async () => {
    const app = await fixture();
    await request(app).get('/api/health').expect(200).expect('Content-Type', /json/);
    for (const path of ['/api', '/api/unexpected', '/api/missing', '/ws', '/ws/missing']) {
      const response = await request(app).get(path).expect(404).expect('Content-Type', /json/);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });
  it('does not fall back to the SPA for non-GET requests', async () => {
    const app = await fixture();
    await request(app).post('/c/a-conversation').expect(404).expect('Content-Type', /json/);
    await request(app).head('/c/a-conversation').expect(404);
  });
  it('ends a successful SPA response without falling through to error handling', async () => {
    const errors: unknown[] = [];
    const app = await fixture(true, error => errors.push(error));
    await request(app).get('/plans/a-plan').expect(200).expect('Content-Type', /html/);
    await setImmediate();
    expect(errors).toEqual([]);
  });
  it('leaves web routes unavailable when static serving is disabled', async () => {
    const app = await fixture(false);
    await request(app).get('/').expect(404).expect('Content-Type', /json/);
    await request(app).get('/assets/app.js').expect(404);
  });
});
