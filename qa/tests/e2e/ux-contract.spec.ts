import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import { WorkspacePage, RealSocketGate, deferred } from '../../fixtures/pages.js';
import { TID } from '../../../packages/shared/src/testids.js';
import { slots } from '../../../packages/shared/src/slots.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import type { PlanDto, StructuredAnswer } from '../../../packages/shared/src/dto.js';

// Local wire types keep additive fields visible while the preparation checkout's shared DTO is older.
type TextRequest = { content: string; clientMessageId: string; payload?: { answeringSlot?: SlotKey; answers?: unknown[] } };
type PlanWithSummary = PlanDto & { generatedEarly?: boolean; knownCount?: number; unknownCount?: number };
type WireMessage = { id: string; role: string; content: string; clientMessageId: string | null; payload: TextRequest['payload'] };
const messageEndpoint = (request: Request, id: string) => request.method() === 'POST'
  && new URL(request.url()).pathname === `/api/conversations/${id}/messages`;

async function sendText(ui: WorkspacePage, id: string, content: string) {
  const received = ui.page.waitForResponse(response => messageEndpoint(response.request(), id));
  await ui.page.getByTestId(TID.composerInput).fill(content);
  await ui.page.getByTestId(TID.composerSend).click();
  const response = await received;
  expect(response.status()).toBe(202);
  const submitted = response.request().postDataJSON() as TextRequest;
  await ui.settled(id);
  return submitted;
}

async function persistedMessage(ui: WorkspacePage, id: string, clientMessageId: string) {
  const response = await ui.page.request.get(`/api/conversations/${id}/messages`, { params: { limit: 100 } });
  expect(response.status()).toBe(200);
  const messages = await response.json() as { items: WireMessage[] };
  const matches = messages.items.filter(message => message.clientMessageId === clientMessageId);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function chooseOther(ui: WorkspacePage, id: string, slot: SlotKey) {
  const assistant = await ui.latestAssistant(id);
  const question = assistant.payload!.questions.find(question => question.slot === slot);
  expect(question, `The genuine latest reply asks ${slot}`).toBeDefined();
  const card = ui.page.getByTestId(TID.message(assistant.seq));
  await expect(card.getByText(question!.text, { exact: true })).toBeVisible();
  // The contractual question order plus shared input labels disambiguates equal button names.
  const eligible = assistant.payload!.questions.filter(item => slots[item.slot].inputLabels?.includes('其他（请输入）'));
  const index = eligible.findIndex(item => item.slot === slot);
  expect(index).toBeGreaterThanOrEqual(0);
  const buttons = card.getByRole('button', { name: '其他（请输入）', exact: true });
  await expect(buttons).toHaveCount(eligible.length);
  const before = await hintSurface(ui.page);
  await buttons.nth(index).click();
  const label = slots[slot].label;
  await expect.poll(async () => {
    const after = await hintSurface(ui.page);
    const addedLine = after.lines.find(line => line.includes(label)
      && after.lines.filter(value => value === line).length > before.lines.filter(value => value === line).length);
    const inputHint = after.input.includes(label) && after.input !== before.input;
    if (inputHint || addedLine) activeHints.set(ui.page, { slot, before, addedLine, inputHint: inputHint ? after.input : undefined });
    return inputHint || Boolean(addedLine);
  }, { message: `Clicking other adds a visible or accessible ${label} prompt` }).toBe(true);
}

type HintSurface = { input: string; lines: string[] };
const activeHints = new WeakMap<Page, { slot: SlotKey; before: HintSurface; addedLine?: string; inputHint?: string }>();
async function hintSurface(page: Page): Promise<HintSurface> {
  const input = await page.getByTestId(TID.composerInput).evaluate(element => {
    const description = element.getAttribute('aria-describedby')?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '').join(' ') ?? '';
    return `${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('aria-label') ?? ''} ${description}`;
  });
  return { input, lines: (await page.locator('body').innerText()).split('\n').map(line => line.trim()).filter(Boolean) };
}

async function expectHintCleared(page: Page, slot: SlotKey) {
  const active = activeHints.get(page);
  expect(active?.slot).toBe(slot);
  await expect.poll(async () => {
    const after = await hintSurface(page);
    if (active!.inputHint && after.input === active!.inputHint) return false;
    return !active!.addedLine || after.lines.filter(line => line === active!.addedLine).length
      <= active!.before.lines.filter(line => line === active!.addedLine).length;
  }, { message: 'The newly introduced prompt is cleared; pre-existing profile labels do not count as prompts' }).toBe(true);
}

async function taxConversation(ui: WorkspacePage, complete = false) {
  const id = await ui.create('我想了解税务。');
  const values: Array<[SlotKey, unknown]> = [['destination', 'PT'], ['applicantNationality', 'CN']];
  if (complete) values.push(['hasPartner', false], ['childrenCount', 0], ['currentResidence', 'CN'],
    ['residenceStatus', 'citizen'], ['timeline', '6to12m'], ['incomeCountry', 'CN']);
  const answers: StructuredAnswer[] = values.map(([slot, value]) => ({ slot, value, label: slots[slot].format(value) }));
  await ui.post(id, '', answers);
  const detail = await ui.settled(id);
  expect(detail.conversation.profile.slots.goals.value).toEqual(['tax']);
  expect(detail.conversation.progress.canGenerateEarly).toBe(true);
  expect(detail.conversation.progress.isComplete).toBe(complete);
  return id;
}

async function generate(ui: WorkspacePage, id: string, allowIncomplete: boolean): Promise<PlanWithSummary> {
  const response = await ui.page.request.post(`/api/conversations/${id}/plan`, { data: { allowIncomplete } });
  expect(response.status()).toBe(201);
  return (await response.json() as { plan: PlanWithSummary }).plan;
}

async function planCount(page: Page, count: number) {
  await expect(page.getByTestId(TID.plansNav)).toContainText(new RegExp(`(?:^|\\D)${count}(?:\\D|$)`));
  await expect(page.getByTestId(TID.plansNav)).not.toContainText(/…|\.\.\./);
}

async function chooseEngine(page: Page, value: 'auto' | 'rules') {
  const engine = page.getByTestId(TID.engineSelect);
  if (await engine.evaluate(element => element.tagName === 'SELECT')) await engine.selectOption(value);
  else {
    await engine.click();
    const name = value === 'auto' ? '自动' : '规则';
    await page.getByRole('option', { name, exact: true }).or(page.getByRole('menuitem', { name, exact: true })).click();
  }
}

async function engineIs(page: Page, value: 'auto' | 'rules') {
  const engine = page.getByTestId(TID.engineSelect);
  if (await engine.evaluate(element => element.tagName === 'SELECT')) await expect(engine).toHaveValue(value);
  else await expect(engine).toContainText(value === 'auto' ? '自动' : '规则');
}

test('E2E-021 其他输入携带所属问题提示且不污染下一条普通文本', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create('我想了解税务。');
  await ui.open(id);
  await chooseOther(ui, id, 'applicantNationality');
  const hinted = await sendText(ui, id, '日本');
  expect(hinted.payload).toEqual({ answeringSlot: 'applicantNationality' });
  expect((await persistedMessage(ui, id, hinted.clientMessageId)).payload).toEqual(hinted.payload);
  const profile = (await ui.detail(id)).conversation.profile;
  expect(profile.slots.applicantNationality).toMatchObject({ status: 'known', value: 'JP' });
  expect(profile.slots.destination.status).toBe('missing');
  await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('日本');
  const ordinary = await sendText(ui, id, '计划时间是明年。');
  expect(ordinary.payload?.answeringSlot).toBeUndefined();
  await expectHintCleared(page, 'applicantNationality');
  expect((await ui.detail(id)).conversation.profile.slots.applicantNationality.value).toBe('JP');
  await testInfo.attach('real-hinted-and-ordinary-requests', { body: JSON.stringify({ hinted, ordinary }), contentType: 'application/json' });
  for (const slot of ['destination', 'currentResidence', 'incomeCountry'] as const) {
    await test.step(`其他输入属于 ${slots[slot].label}`, async () => {
      const target = await ui.create('我想了解税务。');
      if (slot !== 'destination') {
        const values: Array<[SlotKey, unknown]> = [
          ['destination', 'PT'], ['applicantNationality', 'CN'], ['hasPartner', false], ['childrenCount', 0],
        ];
        if (slot === 'incomeCountry') values.push(['currentResidence', 'CN'], ['residenceStatus', 'citizen'], ['timeline', '6to12m']);
        await ui.post(target, '', values.map(([key, value]) => ({ slot: key, value, label: slots[key].format(value) })));
        await ui.settled(target);
      }
      await ui.open(target);
      const before = (await ui.detail(target)).conversation.profile;
      await chooseOther(ui, target, slot);
      const request = await sendText(ui, target, '日本');
      expect(request.payload).toEqual({ answeringSlot: slot });
      const after = (await ui.detail(target)).conversation.profile;
      expect(after.slots[slot]).toMatchObject({ status: 'known', value: 'JP' });
      for (const unaffected of ['destination', 'applicantNationality', 'currentResidence', 'incomeCountry'] as const) {
        if (unaffected !== slot) expect(after.slots[unaffected]).toEqual(before.slots[unaffected]);
      }
    });
  }
});

test('E2E-022 提示文本发送失败后重试保留原标识和所属问题', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.create('我想了解税务。');
  await ui.open(id);
  await chooseOther(ui, id, 'applicantNationality');
  const attempts: TextRequest[] = [];
  await page.route(`**/api/conversations/${id}/messages`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON() as TextRequest);
    if (attempts.length === 1) await route.abort('connectionfailed');
    else await route.continue();
  });
  await page.getByTestId(TID.composerInput).fill('日本');
  await page.getByTestId(TID.composerSend).click();
  await expect(page.getByTestId(TID.messageRetrySend)).toBeVisible();
  const retryResponse = page.waitForResponse(response => messageEndpoint(response.request(), id));
  await page.getByTestId(TID.messageRetrySend).click();
  expect((await retryResponse).status()).toBe(202);
  await ui.settled(id);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.clientMessageId).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[1]!.payload).toEqual({ answeringSlot: 'applicantNationality' });
  expect((await persistedMessage(ui, id, attempts[1]!.clientMessageId)).payload).toEqual(attempts[1]!.payload);
  await expect(page.getByTestId(TID.messageRetrySend)).toHaveCount(0);
  await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('日本');
  await testInfo.attach('real-retry-requests', { body: JSON.stringify(attempts), contentType: 'application/json' });
});

test('E2E-023 快捷回答、咨询切换和账号切换均清除作答提示', async ({ page }) => {
  const ui = new WorkspacePage(page);
  const secondName = await ui.login();
  const secondUserId = await ui.create('我想了解税务。');
  await page.getByTestId(TID.logout).click();
  await ui.login();
  const first = await ui.create('我想了解税务。');
  const other = await ui.create('我想了解税务。');
  await ui.open(first);
  await test.step('快捷回答后下一条文本没有遗留提示', async () => {
    await chooseOther(ui, first, 'applicantNationality');
    await ui.quick(first, 'destination', 'PT');
    await expectHintCleared(page, 'applicantNationality');
    expect((await sendText(ui, first, '计划时间是明年。')).payload?.answeringSlot).toBeUndefined();
    expect((await ui.detail(first)).conversation.profile.slots.applicantNationality.status).toBe('missing');
  });
  await test.step('客户端切换咨询后提示不带到目标或源咨询', async () => {
    await chooseOther(ui, first, 'applicantNationality');
    await page.getByTestId(TID.convItem(other)).click();
    await expect(page).toHaveURL(new RegExp(`/c/${other}$`));
    await expectHintCleared(page, 'applicantNationality');
    expect((await sendText(ui, other, '计划时间是明年。')).payload?.answeringSlot).toBeUndefined();
    await page.getByTestId(TID.convItem(first)).click();
    await expectHintCleared(page, 'applicantNationality');
    expect((await sendText(ui, first, '我是自由职业者。')).payload?.answeringSlot).toBeUndefined();
  });
  await test.step('退出并切换账号后不复用前一账号提示', async () => {
    await chooseOther(ui, first, 'applicantNationality');
    await page.getByTestId(TID.logout).click();
    await ui.login(secondName);
    await page.getByTestId(TID.convItem(secondUserId)).click();
    await expectHintCleared(page, 'applicantNationality');
    expect((await sendText(ui, secondUserId, '计划时间是明年。')).payload?.answeringSlot).toBeUndefined();
    expect((await ui.detail(secondUserId)).conversation.profile.slots.applicantNationality.status).toBe('missing');
  });
});

test('E2E-024 完整资料生成须确认且取消不发生成请求', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await taxConversation(ui, true);
  await ui.open(id);
  const submissions: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/conversations/${id}/plan`) submissions.push(request.postDataJSON());
  });
  await page.getByTestId(TID.generatePlan).click();
  const dialog = page.getByTestId(TID.generateDialog);
  await expect(dialog).toContainText('生成后这个咨询会结束，不能再补充');
  await expect(dialog.getByTestId(TID.generateCancel)).toHaveText('继续补充');
  await expect(dialog.getByTestId(TID.generateConfirm)).toHaveText('生成计划');
  await dialog.getByTestId(TID.generateCancel).click();
  await expect(dialog).toHaveCount(0);
  // Observe cancellation independently before the next explicit confirmation can send any request.
  const unexpected = await page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === `/api/conversations/${id}/plan`, { timeout: 1_000 })
    .then(request => request.url(), error => { expect(error.name).toBe('TimeoutError'); return null; });
  expect(unexpected).toBeNull();
  const cancelled = await ui.detail(id);
  expect(cancelled.conversation.status).toBe('collecting');
  expect(cancelled.plan).toBeNull();
  expect(submissions).toEqual([]);
  await page.getByTestId(TID.generatePlan).click();
  const generated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/conversations/${id}/plan`);
  await page.getByTestId(TID.generateConfirm).click();
  expect((await generated).status()).toBe(201);
  expect(submissions).toEqual([{ allowIncomplete: false }]);
  expect((await ui.detail(id)).conversation.status).toBe('completed');
  await testInfo.attach('confirmation-requests', { body: JSON.stringify(submissions), contentType: 'application/json' });
});

test('E2E-025 计划计数跨各页面、刷新和多标签保持完整', async ({ page, context }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const complete = await taxConversation(ui);
  const firstPlan = await generate(ui, complete, true);
  await generate(ui, await taxConversation(ui), true);
  const collecting = await taxConversation(ui);
  for (const path of ['/', `/c/${collecting}`, `/c/${complete}`, '/plans', `/plans/${firstPlan.id}`]) {
    await test.step(`直接进入并刷新 ${path}`, async () => {
      await page.goto(path);
      await ui.live();
      await planCount(page, 2);
      await page.reload();
      await ui.live();
      await planCount(page, 2);
    });
  }
  const other = await context.newPage();
  const otherUi = new WorkspacePage(other);
  await other.goto('/');
  await otherUi.live();
  await planCount(other, 2);
  await generate(ui, collecting, true);
  await planCount(page, 3);
  await planCount(other, 3);
});

test('E2E-026 计划快照加载显示省略号且旧快照不覆盖新增事件', async ({ page }, testInfo) => {
  const gate = new RealSocketGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const first = await generate(ui, await taxConversation(ui), true);
  const secondId = await taxConversation(ui);
  const captured = deferred();
  const release = deferred();
  const delivered = deferred();
  let intercepted = false;
  let snapshot: unknown;
  const additionalSnapshots: Array<{ ids: string[] }> = [];
  await page.route('**/api/plans', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const firstResponse = !intercepted;
    intercepted = true;
    const response = await route.fetch();
    const body = await response.json() as { items: Array<{ id: string }> };
    if (firstResponse) { snapshot = body; captured.resolve(); }
    else additionalSnapshots.push({ ids: body.items.map(plan => plan.id) });
    // Hold every list response, so a parallel request cannot end the loading
    // state or repair an event overwritten by the older snapshot unnoticed.
    await release.promise;
    await route.fulfill({ response });
    if (firstResponse) delivered.resolve();
  });
  gate.frames = [];
  await page.goto('/plans');
  await captured.promise;
  let second: PlanWithSummary | undefined;
  try {
    expect((snapshot as { items: unknown[] }).items).toHaveLength(1);
    await expect(page.getByTestId(TID.plansNav)).toContainText(/…|\.\.\./);
    second = await generate(ui, secondId, true);
    await expect.poll(() => gate.frames.some(frame => {
      const payload = frame.payload as { plan?: { id?: string } } | undefined;
      return frame.type === 'event' && frame.eventType === 'plan.created' && payload?.plan?.id === second!.id;
    })).toBe(true);
    // A later real event rendered in the sidebar proves the browser processed traffic past plan.created.
    const marker = await ui.create('我想了解税务。');
    try { await expect(page.getByTestId(TID.convItem(marker))).toBeVisible(); }
    catch { throw new Error('BLOCKED: This page does not expose a later real event while the plan snapshot is held; browser processing order cannot be established by this case.'); }
  } finally {
    release.resolve();
    await testInfo.attach('real-old-plan-snapshot-and-new-event', { body: JSON.stringify({ snapshot, additionalSnapshots, events: gate.frames.filter(frame => frame.eventType === 'plan.created') }), contentType: 'application/json' });
  }
  await delivered.promise;
  await ui.live();
  if (additionalSnapshots.some(item => item.ids.includes(second!.id))) {
    throw new Error('BLOCKED: A second fresh plan-list response included the new plan, so this run cannot isolate the older-snapshot versus event merge.');
  }
  await planCount(page, 2);
  await expect(page.getByTestId(TID.planCard(first.id))).toHaveCount(1);
  await expect(page.getByTestId(TID.planCard(second!.id))).toHaveCount(1);
  await testInfo.attach('plan-list-responses-after-ui-checks', { body: JSON.stringify({ snapshot, additionalSnapshots }), contentType: 'application/json' });
  if (additionalSnapshots.some(item => item.ids.includes(second!.id))) {
    throw new Error('BLOCKED: A fresh plan-list response arrived during the UI checks; this run cannot prove the older snapshot retained the new event.');
  }
});

test('E2E-027 真实计划卡片区分完整度、资料数量和精确到秒的时间', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const early = await generate(ui, await taxConversation(ui), true);
  const fullId = await taxConversation(ui, true);
  // A clock-boundary condition ensures equal-minute plans still have distinct seconds, without a fixed delay.
  await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(Math.floor(Date.parse(early.createdAt) / 1000));
  const full = await generate(ui, fullId, false);
  const detailRequests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && /^\/api\/plans\/[^/]+$/.test(new URL(request.url()).pathname)) detailRequests.push(request.url());
  });
  const listResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/plans');
  await page.goto('/plans');
  const summaries = await (await listResponse).json() as { items: PlanWithSummary[] };
  await ui.live();
  const renderedTimes: string[] = [];
  for (const plan of [early, full]) {
    const summary = summaries.items.find(item => item.id === plan.id)!;
    expect(summary.generatedEarly).toBe(plan.content.generatedEarly);
    expect(summary.knownCount).toBe(plan.content.profileSummary.known.length);
    expect(summary.unknownCount).toBe(plan.content.profileSummary.unknown.length);
    const card = page.getByTestId(TID.planCard(plan.id));
    await expect(card).toContainText(plan.content.generatedEarly ? '信息不全时生成' : '信息完整时生成');
    await expect(card).toContainText(new RegExp(`已知\\s*[：:]?\\s*${summary.knownCount}(?:\\D|$)`));
    await expect(card).toContainText(new RegExp(`待了解\\s*[：:]?\\s*${summary.unknownCount}(?:\\D|$)`));
    const text = await card.innerText();
    const time = text.match(/(?:^|[^\d])(\d{1,2})[:：时](\d{1,2})[:：分](\d{1,2})(?:秒|\b)/);
    if (!time) {
      await testInfo.attach('timestamp-format-needs-review', { body: JSON.stringify({ createdAt: plan.createdAt, visibleCard: text }), contentType: 'application/json' });
      throw new Error('BLOCKED: Visible timestamp needs candidate/manual review for second precision; this parser does not treat an unrecognized display format as a product defect.');
    }
    const shown = time!.slice(1, 4).map(Number);
    // Precision and distinguishing actual results are contractual; display timezone and 12/24-hour format are not.
    expect(shown[2]).toBe(new Date(plan.createdAt).getUTCSeconds());
    renderedTimes.push(shown.join(':'));
  }
  expect(renderedTimes[0]).not.toBe(renderedTimes[1]);
  expect(detailRequests, 'The list has its summary metadata without fetching each plan detail').toEqual([]);
  await testInfo.attach('real-plan-content-and-summaries', { body: JSON.stringify({ early, full, summaries }), contentType: 'application/json' });
});

test('E2E-028 真实空计划阶段显示暂无事项提示', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const plan = await generate(ui, await taxConversation(ui, true), false);
  const emptyPhases = plan.content.phases.filter(phase => phase.steps.length === 0);
  await testInfo.attach('real-plan-empty-phases', { body: JSON.stringify(plan.content.phases), contentType: 'application/json' });
  if (!emptyPhases.length) throw new Error('BLOCKED: The public tax-only plan has no empty phase; this case needs an actual empty-phase precondition and does not classify its absence as a product defect.');
  await page.goto(`/plans/${plan.id}`);
  await ui.live();
  await expect(page.getByText('该阶段暂无事项', { exact: true })).toHaveCount(emptyPhases.length);
  for (const [index, phase] of plan.content.phases.entries()) {
    const heading = page.getByText(phase.label, { exact: true });
    await expect(heading).toBeVisible();
    const next = plan.content.phases[index + 1];
    const nextHeading = next ? await page.getByText(next.label, { exact: true }).elementHandle() : null;
    try {
      // Inspect the content between public phase labels without assuming a
      // particular section wrapper or CSS class in the implementation.
      const phaseText = await heading.evaluate((element, following) => {
        const range = document.createRange();
        range.selectNodeContents(document.body);
        range.setStartAfter(element);
        if (following) range.setEndBefore(following);
        return range.toString();
      }, nextHeading);
      if (phase.steps.length === 0) expect(phaseText).toContain('该阶段暂无事项');
      else expect(phaseText).not.toContain('该阶段暂无事项');
    } finally { await nextHeading?.dispose(); }
    for (const step of phase.steps) await expect(page.getByTestId(TID.planStep(step.id))).toContainText(step.title);
  }
});

test('E2E-029 首次和后续新咨询均显示开始新的咨询', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const heading = page.getByRole('heading', { name: '开始新的咨询', exact: true });
  await expect(heading).toBeVisible();
  const first = await ui.send('我想了解税务。');
  await ui.settled(first);
  await page.getByTestId(TID.newConversation).click();
  await expect(heading).toBeVisible();
  await generate(ui, await taxConversation(ui), true);
  await page.reload();
  await ui.live();
  await expect(heading).toBeVisible();
  await expect(page.getByTestId(TID.exampleCard(0))).toBeVisible();
});

test('E2E-030 主动引擎选择刷新和新建沿用且浏览旧咨询不覆盖', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const oldAuto = await ui.create('我想了解税务。', 'auto');
  await page.getByTestId(TID.newConversation).click();
  await engineIs(page, 'auto');
  await chooseEngine(page, 'rules');
  await page.reload();
  await ui.live();
  await engineIs(page, 'rules');
  const first = await ui.send('我想了解税务。');
  await ui.settled(first);
  expect((await ui.detail(first)).conversation.enginePreference).toBe('rules');
  await page.getByTestId(TID.convItem(oldAuto)).click();
  await engineIs(page, 'auto');
  expect((await ui.detail(oldAuto)).conversation.enginePreference).toBe('auto');
  await page.getByTestId(TID.newConversation).click();
  await engineIs(page, 'rules');
  const second = await ui.send('我想了解税务。');
  await ui.settled(second);
  expect((await ui.detail(second)).conversation.enginePreference).toBe('rules');
  await chooseEngine(page, 'auto');
  await expect.poll(async () => (await ui.detail(second)).conversation.enginePreference).toBe('auto');
  await page.getByTestId(TID.newConversation).click();
  await engineIs(page, 'auto');
});

test('E2E-031 引擎选择按账号隔离且首次自动能回退规则', async ({ page }) => {
  const ui = new WorkspacePage(page);
  const firstName = await ui.login(`qa-a-${randomUUID().slice(0, 20)}`);
  await engineIs(page, 'auto');
  await chooseEngine(page, 'rules');
  await page.getByTestId(TID.logout).click();
  const secondName = await ui.login(`qa-b-${randomUUID().slice(0, 20)}`);
  await engineIs(page, 'auto');
  const id = await ui.send('我想了解税务。');
  await ui.settled(id);
  expect((await ui.detail(id)).conversation.enginePreference).toBe('auto');
  expect((await ui.latestAssistant(id)).payload!.process.engineUsed).toBe('rules');
  await page.getByTestId(TID.logout).click();
  await ui.login(firstName);
  await page.getByTestId(TID.newConversation).click();
  await engineIs(page, 'rules');
  await page.reload();
  await ui.live();
  await engineIs(page, 'rules');
  await page.getByTestId(TID.logout).click();
  await ui.login(secondName);
  await page.getByTestId(TID.newConversation).click();
  await engineIs(page, 'auto');
});
