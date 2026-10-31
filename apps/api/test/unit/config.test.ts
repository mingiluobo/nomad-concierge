import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('configuration', () => {
  it('uses a model-free baseline and production serving default', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 3001, llmApiKey: '', localLlmModel: '', turnTimeoutMs: 60000, serveWebDist: false });
    expect(loadConfig({ NODE_ENV: 'production' }).serveWebDist).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', SERVE_WEB_DIST: 'false' }).serveWebDist).toBe(false);
  });
  it('accepts isolated ports and multiple origins, and caps demo delay', () => {
    expect(loadConfig({ PORT: '0', WEB_ORIGIN: 'http://localhost:1000, http://localhost:2000', DEMO_DELAY_MS: '20000' })).toMatchObject({ port: 0, webOrigins: ['http://localhost:1000', 'http://localhost:2000'], demoDelayMs: 10000 });
  });
  it('rejects invalid timeout budgets and unparseable booleans', () => {
    expect(() => loadConfig({ TURN_TIMEOUT_MS: '45000' })).toThrow('must exceed');
    expect(() => loadConfig({ SERVE_WEB_DIST: 'no' })).toThrow();
    expect(() => loadConfig({ WEB_ORIGIN: 'not-a-url' })).toThrow();
  });
});
