import { test as base, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { AppInstance } from '../harness/app.js';
import { ApiClient } from '../harness/api.js';

type Options = { appEnv: Record<string, string> };
type Fixtures = { app: AppInstance; api: ApiClient };
export const test = base.extend<Options & Fixtures>({
  appEnv: [{}, { option: true }],
  app: async ({ appEnv }, provide, testInfo) => {
    const app = new AppInstance(process.env.QA_BUILD_ROOT ?? resolve(process.cwd(), '..'), appEnv);
    try { await app.initialize(); await provide(app); }
    finally {
      await app.dispose(testInfo.outputPath('server'));
      await testInfo.attach('owned-instance', { path: testInfo.outputPath('server/instance.json'), contentType: 'application/json' });
      await testInfo.attach('fake-requests', { path: testInfo.outputPath('server/fake-requests.json'), contentType: 'application/json' });
      await testInfo.attach('api-process', { path: testInfo.outputPath('server/api-process.log'), contentType: 'text/plain' });
    }
  },
  baseURL: async ({ app }, provide) => { await provide(app.baseURL); },
  api: async ({ request }, provide) => { await provide(new ApiClient(request)); },
  page: async ({ page, app }, provide) => {
    const context = page.context();
    // Browser requests may only reach the owned app. Fake model traffic is server-side.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === app.baseURL || url.protocol === 'data:' || url.protocol === 'blob:') await route.continue();
      else await route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.host === new URL(app.baseURL).host) socket.connectToServer();
      else socket.close({ code: 1008, reason: 'QA execution permits only the owned server' });
    });
    await provide(page);
  },
});
export { expect };
