import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures/test.js';
import { WorkspacePage, RealSocketGate, accumulateEvents, deferred } from '../../fixtures/pages.js';
import { TID } from '../../../packages/shared/src/testids.js';

async function history(ui: WorkspacePage) {
  const id = await ui.create();
  for (let round = 0; round < 17; round += 1) {
    await ui.post(id, `计划时间是${round % 2 ? '明年' : '下个月'}`);
    await ui.settled(id);
  }
  const messages = (await ui.messages(id)).items;
  expect(messages).toHaveLength(36);
  return { id, messages };
}

test('E2E-012 游标分页与同时新增消息不重不漏', async ({ page }) => {
  test.setTimeout(120_000);
  const ui = new WorkspacePage(page);
  await ui.login();
  const { id, messages } = await history(ui);
  await ui.open(id);
  for (const message of messages.slice(6)) await expect(page.getByTestId(TID.message(message.seq))).toHaveCount(1);
  await expect(page.getByTestId(TID.message(1))).toHaveCount(0);
  const captured = deferred();
  const release = deferred();
  await page.route(`**/api/conversations/${id}/messages?*`, async route => {
    if (!new URL(route.request().url()).searchParams.has('before')) { await route.continue(); return; }
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByTestId(TID.loadOlder).click();
  await captured.promise;
  try {
    await ui.post(id, '我是自由职业者');
    await ui.settled(id);
  } finally { release.resolve(); }
  const after = (await ui.messages(id)).items;
  expect(after).toHaveLength(38);
  for (const message of after) await expect(page.getByTestId(TID.message(message.seq))).toHaveCount(1);
  await expect(page.getByTestId(TID.loadOlder)).toHaveCount(0);
  const rendered = await page.locator('[data-testid]').evaluateAll((elements, idToSeq) => elements
    .map(element => element.getAttribute('data-testid'))
    .filter((value): value is string => value !== null && Object.hasOwn(idToSeq, value))
    .map(value => idToSeq[value]), Object.fromEntries(after.map(message => [TID.message(message.seq), message.seq])));
  expect(rendered).toEqual(after.map(message => message.seq));
});

test.describe('真实快照乱序', () => {
  test.use({ appEnv: { DEMO_DELAY_MS: '5000' } });
  test('E2E-013 初次同步的旧快照不覆盖较新任务和档案事件', async ({ page }) => {
    const gate = new RealSocketGate();
    await gate.attach(page);
    const ui = new WorkspacePage(page);
    await ui.login();
    const id = await ui.create('我是中国人，想搬到葡萄牙生活。');
    gate.frames = [];
    const captured = deferred();
    const release = deferred();
    let intercepted = false;
    let readyBeforeSnapshot = false;
    await page.route(`**/api/conversations/${id}`, async route => {
      if (intercepted || route.request().method() !== 'GET') { await route.continue(); return; }
      intercepted = true;
      readyBeforeSnapshot = gate.frames.some(frame => frame.type === 'ready');
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await page.goto(`/c/${id}`);
    await captured.promise;
    try {
      const posted = await ui.post(id, '我的国籍改成葡萄牙。');
      await expect.poll(async () => (await ui.detail(id)).activeTurn?.status).toBe('running');
      expect(posted.turn).not.toBeNull();
      await expect.poll(() => gate.frames.some(frame => {
        const payload = frame.payload as { turn?: { id?: string; status?: string } } | undefined;
        return frame.type === 'event' && frame.eventType === 'turn.upserted' && payload?.turn?.id === posted.turn?.id && payload?.turn?.status === 'running';
      })).toBe(true);
    } finally { release.resolve(); }
    await ui.live();
    expect(readyBeforeSnapshot).toBe(true);
    await expect(page.getByTestId(TID.convBusy(id))).toBeVisible();
    await expect(page.getByTestId(TID.turnProgress)).toBeVisible();
    await ui.settled(id);
    await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('葡萄牙');
    expect((await ui.detail(id)).conversation.profile.slots.applicantNationality.value).toBe('PT');
  });
});

test('E2E-014 超过一千事件后会话页完整重同步', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create();
  await ui.open(id);
  const previous = gate.resyncCount;
  gate.disconnect();
  await expect(page.getByTestId(TID.connectionStatus)).toContainText(/重连|断开/);
  await accumulateEvents(ui, id);
  await ui.post(id, '现在住在葡萄牙。');
  await ui.settled(id);
  const before = await ui.detail(id);
  const messages = (await ui.messages(id)).items;
  gate.online = true;
  await expect.poll(() => gate.resyncCount, { timeout: 25_000 }).toBeGreaterThan(previous);
  await ui.live();
  await ui.assertMessages(messages);
  await expect(page.getByTestId(TID.profileSlot('currentResidence'))).toContainText('葡萄牙');
  expect((await ui.detail(id)).conversation.profile).toEqual(before.conversation.profile);
  await testInfo.attach('real-resync-frames', { body: JSON.stringify(gate.frames.filter(frame => frame.type !== 'event')), contentType: 'application/json' });
});

test('E2E-015 整体重同步恢复我的计划列表', async ({ page }) => {
  test.setTimeout(180_000);
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const firstId = await ui.create();
  const firstPlan = await ui.generateEarly(firstId);
  const traffic = await ui.create();
  await page.goto('/plans');
  await ui.live();
  await expect(page.getByTestId(TID.planCard(firstPlan.id))).toBeVisible();
  const previous = gate.resyncCount;
  gate.disconnect();
  await accumulateEvents(ui, traffic);
  const secondId = await ui.create('我是中国人，想搬到智利生活。');
  const secondPlan = await ui.generateEarly(secondId);
  const captured = deferred();
  const release = deferred();
  await page.route('**/api/plans', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    gate.online = true;
    await expect.poll(() => gate.resyncCount, { timeout: 25_000 }).toBeGreaterThan(previous);
    await captured.promise;
    await expect(page.getByTestId(TID.plansNav)).toContainText(/…|\.\.\./);
  } finally { release.resolve(); }
  await ui.live();
  await expect(page.getByTestId(TID.plansNav)).toContainText(/(?:^|\D)2(?:\D|$)/);
  await expect(page.getByTestId(TID.plansNav)).not.toContainText(/…|\.\.\./);
  await expect(page.getByTestId(TID.planCard(firstPlan.id))).toHaveCount(1);
  await expect(page.getByTestId(TID.planCard(secondPlan.id))).toHaveCount(1);
  await expect(page.getByTestId(TID.planCard(secondPlan.id))).toContainText('通用准备清单');
});

test('E2E-016 计划详情页首次连接和整体重同步内容完整', async ({ page }) => {
  test.setTimeout(180_000);
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create();
  const plan = await ui.generateEarly(id);
  const traffic = await ui.create();
  await page.goto(`/plans/${plan.id}`);
  await ui.live();
  await expect(page.getByTestId(TID.planDisclaimer)).toBeVisible();
  const content = await page.getByTestId(TID.planFirstStep).innerText();
  expect(content.length).toBeGreaterThan(0);
  const previous = gate.resyncCount;
  gate.disconnect();
  await accumulateEvents(ui, traffic);
  gate.online = true;
  await expect.poll(() => gate.resyncCount, { timeout: 25_000 }).toBeGreaterThan(previous);
  await ui.live();
  await expect(page.getByTestId(TID.planFirstStep)).toHaveText(content, { useInnerText: true });
  await expect(page.getByTestId(TID.planKnown)).toContainText('中国');
  await expect(page.getByTestId(TID.planUnknown)).toContainText('当前居住国');
  await expect(page.getByTestId(TID.planBoundary)).not.toBeEmpty();
  await expect(page.getByTestId(TID.planDisclaimer)).toBeVisible();
  await expect(page.getByTestId(TID.planDisclaimer)).toContainText('不能替代持牌专业人士');
  for (const phase of plan.content.phases) for (const step of phase.steps) {
    await expect(page.getByTestId(TID.planStep(step.id))).toContainText(step.title);
  }
});

test('E2E-017 断线期间其他标签切换身份后不混用数据', async ({ page, context }) => {
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login(`qa-first-${randomUUID().slice(0, 20)}`);
  const first = await ui.create('我是中国人，想搬到葡萄牙生活。');
  await ui.open(first);
  gate.disconnect();
  const secondPage = await context.newPage();
  const second = new WorkspacePage(secondPage);
  await second.open(first);
  await secondPage.getByTestId(TID.logout).click();
  await expect(secondPage).toHaveURL(/\/login$/);
  const secondName = `qa-second-${randomUUID().slice(0, 20)}`;
  await second.login(secondName);
  const secondId = await second.create('我是日本人，想搬到智利生活。');
  const me = await (await secondPage.request.get('/api/me')).json() as { user: { id: string } };
  gate.online = true;
  await expect.poll(() => gate.frames.some(frame => frame.type === 'ready' && frame.userId === me.user.id), { timeout: 25_000 }).toBe(true);
  await expect(page.getByTestId(TID.convItem(first))).toHaveCount(0);
  await expect(page.getByTestId(TID.convItem(secondId))).toBeVisible();
  await page.getByTestId(TID.convItem(secondId)).click();
  await ui.live();
  await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('日本');
  await expect(page.getByTestId(TID.profileSlot('destination'))).toContainText('智利');
  expect((await ui.detail(secondId)).conversation.id).toBe(secondId);
  expect((await page.request.get(`/api/conversations/${first}`)).status()).toBe(404);
});

test('E2E-018 重同步前迟到的旧翻页响应不污染数据和游标', async ({ page }) => {
  test.setTimeout(180_000);
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const { id } = await history(ui);
  await ui.open(id);
  const captured = deferred();
  const release = deferred();
  const delivered = deferred();
  let intercepted = false;
  await page.route(`**/api/conversations/${id}/messages?*`, async route => {
    if (intercepted || !new URL(route.request().url()).searchParams.has('before')) { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch();
    captured.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  await page.getByTestId(TID.loadOlder).click();
  await captured.promise;
  const previous = gate.resyncCount;
  try {
    gate.disconnect();
    await accumulateEvents(ui, id);
    await ui.post(id, '我是自由职业者');
    await ui.settled(id);
    gate.online = true;
    await expect.poll(() => gate.resyncCount, { timeout: 25_000 }).toBeGreaterThan(previous);
    await ui.live();
    await expect(page.getByTestId(TID.message(1))).toHaveCount(0);
  } finally { release.resolve(); }
  await delivered.promise;
  // A subsequent real assistant event provides a positive browser-processing boundary.
  await ui.post(id, '计划时间是明年');
  await ui.settled(id);
  await expect(page.getByTestId(TID.message(40))).toBeVisible();
  await expect(page.getByTestId(TID.message(1))).toHaveCount(0);
  await page.unroute(`**/api/conversations/${id}/messages?*`);
  await expect(page.getByTestId(TID.loadOlder)).toBeVisible();
  await page.getByTestId(TID.loadOlder).click();
  const all = (await ui.messages(id)).items;
  expect(all).toHaveLength(40);
  for (const message of all) await expect(page.getByTestId(TID.message(message.seq))).toHaveCount(1);
  await expect(page.getByTestId(TID.loadOlder)).toHaveCount(0);
});
