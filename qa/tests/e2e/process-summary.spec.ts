import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import { WorkspacePage, deferred } from '../../fixtures/pages.js';
import { enginesResponseSchema } from '../../../packages/shared/src/dto.js';
import { TID } from '../../../packages/shared/src/testids.js';

const historyNote = '当前未配置，历史记录为不可用';
const enginesResponse = (page: Page) => page.waitForResponse(response =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/engines');

async function normalRulesSummary(process: Locator) {
  // innerText only observes the displayed summary, excluding collapsed details.
  await expect(process).toBeVisible();
  await expect.poll(async () => {
    const text = await process.innerText();
    return { text, normal: /规则[\s\S]*\d+(?:\.\d+)?\s*(?:ms|毫秒)/.test(text) && !text.includes('回退') };
  }).toMatchObject({ normal: true });
}

test('E2E-036 未配置模型时正常规则摘要、展开历史不可用说明且数据不变', async ({ page, app }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create('我是中国人，想搬到葡萄牙生活。', 'auto');
  const assistant = await ui.latestAssistant(id);
  expect(assistant.payload!.process).toMatchObject({
    engineUsed: 'rules',
    fallbacks: [{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'unavailable' }],
  });
  const received = enginesResponse(page);
  await ui.open(id);
  const response = await received;
  expect(response.status()).toBe(200);
  const engines = enginesResponseSchema.parse(await response.json());
  for (const name of ['remote', 'local']) {
    expect(engines.engines.find(engine => engine.id === name)).toMatchObject({ available: false, reason: 'not_configured' });
  }
  const process = page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.processInfo);
  await normalRulesSummary(process);
  expect(await process.innerText()).not.toContain(historyNote);
  await process.click();
  await expect.poll(() => process.innerText()).toContain(historyNote);
  await expect.poll(() => process.innerText()).toMatch(/远程|remote|DeepSeek/);
  await expect.poll(() => process.innerText()).toMatch(/本地|local/);
  const after = await ui.latestAssistant(id);
  expect(after.payload!.process).toEqual(assistant.payload!.process);
  expect([...app.fakeRemote.requests, ...app.fakeLocal.requests].filter(request => request.path.endsWith('/chat/completions'))).toHaveLength(0);
  await testInfo.attach('unconfigured-process-summary', {
    body: JSON.stringify({ engines, before: assistant.payload!.process, after: after.payload!.process, expanded: await process.innerText() }, null, 2),
    contentType: 'application/json',
  });
});

test.describe('已配置模型的真实故障回退摘要', () => {
  test.use({ appEnv: { LLM_API_KEY: 'qa-fake-key', LLM_TIMEOUT_MS: '200', TURN_TIMEOUT_MS: '5000', BREAKER_FAILURES: '100' } });

  test('E2E-037 已配置模型调用失败和超时均保留回退提示', async ({ page, app }, testInfo) => {
    const ui = new WorkspacePage(page);
    await ui.login();
    const observations: unknown[] = [];
    for (const scenario of [
      { behavior: { kind: 'http', status: 500 } as const, reason: 'unavailable', content: '我想搬到葡萄牙生活。' },
      { behavior: { kind: 'hang' } as const, reason: 'timeout', content: '我想去西班牙生活。' },
    ]) {
      app.fakeRemote.setBehavior(scenario.behavior);
      const callCount = app.fakeRemote.requests.filter(request => request.path.endsWith('/chat/completions')).length;
      const id = await ui.create(scenario.content, 'remote');
      const assistant = await ui.latestAssistant(id);
      expect(assistant.payload!.process).toMatchObject({ engineUsed: 'rules', fallbacks: [{ engine: 'remote', reason: scenario.reason }] });
      expect(app.fakeRemote.requests.filter(request => request.path.endsWith('/chat/completions'))).toHaveLength(callCount + 1);
      const received = enginesResponse(page);
      await ui.open(id);
      const response = await received;
      expect(response.status()).toBe(200);
      const engines = enginesResponseSchema.parse(await response.json());
      expect(engines.engines.find(engine => engine.id === 'remote')).toMatchObject({ available: true });
      const process = page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.processInfo);
      await expect(process).toBeVisible();
      await expect.poll(() => process.innerText()).toContain('已回退到规则');
      await process.click();
      await expect.poll(() => process.innerText()).toMatch(/远程|remote|DeepSeek/);
      await expect.poll(() => process.innerText()).toMatch(scenario.reason === 'timeout' ? /timeout|超时/ : /unavailable|不可用|调用失败/);
      expect(await process.innerText()).not.toContain(historyNote);
      expect((await ui.latestAssistant(id)).payload!.process).toEqual(assistant.payload!.process);
      observations.push({ reason: scenario.reason, engines, process: assistant.payload!.process, expanded: await process.innerText() });
    }
    await testInfo.attach('configured-failure-process-summaries', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
  });
});

test('E2E-038 当前引擎状态缺失仍提示回退，真实状态到达后只改变摘要', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create('我是中国人，想搬到葡萄牙生活。', 'auto');
  const assistant = await ui.latestAssistant(id);
  expect(assistant.payload!.process).toMatchObject({
    engineUsed: 'rules',
    fallbacks: [{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'unavailable' }],
  });

  // A fresh document has no in-memory engine snapshot. Hold every genuine engine
  // response, while allowing the genuine conversation and message snapshots through.
  const fresh = await page.context().newPage();
  const release = deferred();
  const snapshots: unknown[] = [];
  const routeErrors: string[] = [];
  let delivered = 0;
  let missingStateSummary = '';
  let configuredSummary = '';
  await fresh.route('**/api/engines', async route => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const snapshot = enginesResponseSchema.parse(await response.json());
      snapshots.push(snapshot);
      await release.promise;
      await route.fulfill({ response });
      delivered += 1;
    } catch (error) {
      routeErrors.push(String(error));
      await route.abort().catch(() => undefined);
    }
  });
  try {
    await fresh.goto(`/c/${id}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => snapshots.length).toBeGreaterThan(0);
    expect(routeErrors).toEqual([]);
    const process = fresh.getByTestId(TID.message(assistant.seq)).getByTestId(TID.processInfo);
    try { await expect(process).toBeVisible(); }
    catch { throw new Error('BLOCKED: Historical process details are not observable while the real engine response is held; the missing-current-state precondition cannot be exercised by this case.'); }
    expect(delivered).toBe(0);
    await expect.poll(() => process.innerText()).toContain('已回退到规则');
    missingStateSummary = await process.innerText();
    expect(missingStateSummary).not.toContain(historyNote);
    expect(delivered).toBe(0);
    release.resolve();
    await expect.poll(() => delivered).toBeGreaterThan(0);
    await normalRulesSummary(process);
    configuredSummary = await process.innerText();
    await new WorkspacePage(fresh).live();
    expect(routeErrors).toEqual([]);
    for (const value of snapshots) {
      const snapshot = enginesResponseSchema.parse(value);
      for (const name of ['remote', 'local']) {
        expect(snapshot.engines.find(engine => engine.id === name)).toMatchObject({ available: false, reason: 'not_configured' });
      }
    }
    expect((await ui.latestAssistant(id)).payload!.process).toEqual(assistant.payload!.process);
  } finally {
    release.resolve();
    await fresh.unrouteAll({ behavior: 'wait' });
    await testInfo.attach('delayed-real-engine-state', {
      body: JSON.stringify({ snapshots, delivered, routeErrors, missingStateSummary, configuredSummary, storedProcess: assistant.payload!.process }, null, 2),
      contentType: 'application/json',
    });
    await fresh.close();
  }
});
