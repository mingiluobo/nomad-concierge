import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures/test.js';
import { FAMILY_EXAMPLE, WorkspacePage } from '../../fixtures/pages.js';
import { TID } from '../../../packages/shared/src/testids.js';
import { slotKeys } from '../../../packages/shared/src/profile.js';
import { planResponseSchema, conversationListResponseSchema } from '../../../packages/shared/src/dto.js';

test('E2E-001 登录、示例、快捷回答、修正与完整计划', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  await expect(page.getByTestId(TID.disclaimerBar)).toContainText('不能替代持牌专业人士');
  await page.getByTestId(TID.exampleCard(0)).click();
  await expect(page.getByTestId(TID.composerInput)).toHaveValue(FAMILY_EXAMPLE);
  const emptyList = conversationListResponseSchema.parse(await (await page.request.get('/api/conversations')).json());
  expect(emptyList.items).toHaveLength(0);
  const id = await ui.send(FAMILY_EXAMPLE);
  const initial = await ui.settled(id);
  expect(initial.conversation.profile.slots.applicantNationality.status).toBe('missing');
  expect(initial.conversation.profile.slots.currentResidence.status).toBe('missing');
  expect(initial.conversation.profile.slots.residenceStatus.status).toBe('missing');
  expect(initial.conversation.profile.slots.destination.value).toBe('PT');
  expect(initial.conversation.profile.slots.goals.value).toEqual(expect.arrayContaining(['residence', 'company', 'tax', 'education']));
  await ui.quick(id, 'applicantNationality', 'CN');
  await ui.quick(id, 'partnerNationality', 'CN');
  const answers: Record<string, { value: unknown; text?: string }> = {
    childrenCount: { value: 2 }, childrenAges: { value: [6, 9], text: '孩子 6 岁和 9 岁' },
    currentResidence: { value: 'CN' }, residenceStatus: { value: 'citizen' }, timeline: { value: '6to12m' },
    incomeSource: { value: 'freelancer' }, businessType: { value: 'software' }, incomeCountry: { value: 'CN' },
    schoolPreference: { value: 'public' },
  };
  for (let round = 0; round < 15; round += 1) {
    if ((await ui.detail(id)).conversation.progress.isComplete) break;
    const assistant = await ui.latestAssistant(id);
    expect(assistant.payload!.questions.length).toBeGreaterThan(0);
    expect(assistant.payload!.questions.length).toBeLessThanOrEqual(2);
    const question = assistant.payload!.questions[0]!;
    const answer = answers[question.slot];
    expect(answer, `An explicitly specified answer exists for ${question.slot}`).toBeDefined();
    if (answer!.text) {
      await ui.send(answer!.text!);
      await ui.settled(id);
    } else await ui.quick(id, question.slot, answer!.value);
  }
  const before = (await ui.detail(id)).conversation.profile;
  expect((await ui.detail(id)).conversation.progress.isComplete).toBe(true);
  await ui.send('配偶是葡萄牙籍');
  const corrected = await ui.settled(id);
  expect(corrected.conversation.profile.slots.partnerNationality).toMatchObject({ status: 'known', value: 'PT', previousValue: 'CN', corrected: true });
  for (const slot of slotKeys.filter(slot => slot !== 'partnerNationality')) {
    expect(corrected.conversation.profile.slots[slot]).toEqual(before.slots[slot]);
  }
  const assistant = await ui.latestAssistant(id);
  await expect(page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.correction('partnerNationality'))).toContainText('中国');
  await expect(page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.correction('partnerNationality'))).toContainText('葡萄牙');
  await page.getByTestId(TID.generatePlan).click();
  await expect.poll(async () => (await ui.detail(id)).conversation.status).toBe('completed');
  const result = await ui.detail(id);
  expect(result.plan).not.toBeNull();
  await page.goto(`/c/${id}`);
  await ui.live();
  await expect(page.getByTestId(TID.composerCompletedBanner)).toBeVisible();
  await expect(page.getByTestId(TID.composerInput)).toHaveCount(0);
  await page.goto(`/plans/${result.plan!.id}`);
  await ui.live();
  const plan = planResponseSchema.parse(await (await page.request.get(`/api/plans/${result.plan!.id}`)).json()).plan;
  expect(plan.content.generatedEarly).toBe(false);
  expect(plan.content.coverage).toBe('full');
  expect(plan.content.profileSummary.known).toEqual(expect.arrayContaining([
    expect.objectContaining({ slot: 'applicantNationality', display: '中国' }),
    expect.objectContaining({ slot: 'partnerNationality', display: '葡萄牙' }),
  ]));
  await expect(page.getByTestId(TID.planFirstStep)).not.toBeEmpty();
  await expect(page.getByTestId(TID.planKnown)).toContainText('葡萄牙');
  await expect(page.getByTestId(TID.planUnknown)).toBeVisible();
  await expect(page.getByTestId(TID.planToConfirm)).toBeVisible();
  await expect(page.getByTestId(TID.planBoundary)).toContainText('持牌');
  await expect(page.getByTestId(TID.planDisclaimer)).toContainText('不能替代持牌专业人士');
  expect(plan.content.sources.length).toBeGreaterThan(0);
  await expect(page.getByText('资料来源', { exact: true }).first()).toBeVisible();
  for (const phase of plan.content.phases) for (const step of phase.steps) {
    await expect(page.getByTestId(TID.planStep(step.id))).toContainText(step.title);
    await expect(page.getByTestId(TID.planStep(step.id))).toContainText(step.why);
    for (const material of step.materials) await expect(page.getByTestId(TID.planStep(step.id))).toContainText(material);
  }
});

test('E2E-002 刷新恢复完整对话、档案、过程与计划', async ({ page }, testInfo) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我是中国人，打算明年独自搬到葡萄牙生活，没有孩子，现在住在中国，是公民，收入来源是自由职业。');
  await ui.settled(id);
  await ui.send('时间改成下个月');
  await ui.settled(id);
  const plan = await ui.generateEarly(id);
  await ui.open(id);
  const before = await ui.detail(id);
  const messagesBefore = await ui.messages(id);
  const profileText = await page.getByTestId(TID.profilePanel).innerText();
  const processText = await page.getByTestId(TID.processInfo).allTextContents();
  await page.reload();
  await ui.live();
  await ui.assertMessages(messagesBefore.items);
  await expect(page.getByTestId(TID.profilePanel)).toHaveText(profileText, { useInnerText: true });
  await expect(page.getByTestId(TID.processInfo)).toHaveText(processText);
  const after = await ui.detail(id);
  expect(after.conversation.profile).toEqual(before.conversation.profile);
  expect(after.plan).toEqual(before.plan);
  expect((await ui.messages(id)).items).toEqual(messagesBefore.items);
  expect(messagesBefore.items.map(message => message.seq)).toEqual(messagesBefore.items.map((_, index) => index + 1));
  await page.goto(`/plans/${plan.id}`);
  await ui.live();
  const firstStep = await page.getByTestId(TID.planFirstStep).innerText();
  await page.reload();
  await ui.live();
  await expect(page.getByTestId(TID.planFirstStep)).toHaveText(firstStep, { useInnerText: true });
  expect(planResponseSchema.parse(await (await page.request.get(`/api/plans/${plan.id}`)).json()).plan).toEqual(plan);
  await testInfo.attach('persisted-snapshot', { body: JSON.stringify({ conversation: before, messages: messagesBefore, plan }, null, 2), contentType: 'application/json' });
});

test('E2E-003 多标签消息同步与跨会话未读消除', async ({ page, context }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const first = await ui.create();
  await ui.open(first);
  const otherPage = await context.newPage();
  const other = new WorkspacePage(otherPage);
  await other.open(first);
  await ui.send('我是自由职业者');
  await ui.settled(first);
  const messages = (await ui.messages(first)).items;
  await ui.assertMessages(messages);
  await other.assertMessages(messages);
  const second = await ui.create('我是葡萄牙人，想了解开公司的准备。');
  await expect(page.getByTestId(TID.convUnreadDot(second))).toBeVisible();
  await expect(otherPage.getByTestId(TID.convUnreadDot(second))).toBeVisible();
  await otherPage.bringToFront();
  await otherPage.getByTestId(TID.convItem(second)).click();
  await expect(otherPage.getByTestId(TID.convUnreadDot(second))).toHaveCount(0);
  await expect(page.getByTestId(TID.convUnreadDot(second))).toHaveCount(0);
  const detail = await other.detail(second);
  expect(detail.readState.lastReadSeq).toBe(detail.conversation.lastAssistantSeq);
});

test.describe('可见的任务过程', () => {
  test.use({ appEnv: { DEMO_DELAY_MS: '1800' } });
  test('E2E-004 停止、重试与运行中的补充', async ({ page }) => {
    const ui = new WorkspacePage(page);
    await ui.login();
    const id = await ui.send('我想去葡萄牙生活。');
    await expect(page.getByTestId(TID.turnStage('understanding'))).toBeVisible();
    const original = (await ui.detail(id)).activeTurn;
    expect(original).not.toBeNull();
    await page.getByTestId(TID.turnStop).click();
    await expect(page.getByTestId(TID.turnCancelled)).toBeVisible();
    expect((await ui.detail(id)).latestTurn?.status).toBe('cancelled');
    await page.getByTestId(TID.turnRetry).click();
    await expect(page.getByTestId(TID.turnStage('understanding'))).toBeVisible();
    const retry = (await ui.detail(id)).activeTurn;
    expect(retry?.id).not.toBe(original?.id);
    expect(retry?.retryOfTurnId).toBe(original?.id);
    await expect(page.getByTestId(TID.composerInput)).toHaveAttribute('placeholder', /补充/);
    await ui.send('我是中国人，独自前往，没有孩子。');
    const completed = await ui.settled(id);
    expect(completed.latestTurn?.id).not.toBe(retry?.id);
    expect(completed.conversation.profile.slots.destination.value).toBe('PT');
    expect(completed.conversation.profile.slots.applicantNationality.value).toBe('CN');
    expect(completed.conversation.profile.slots.childrenCount.value).toBe(0);
    const messages = (await ui.messages(id)).items;
    expect(messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(messages.some(message => message.turnId === original?.id && message.role === 'assistant')).toBe(false);
    expect(messages.some(message => message.turnId === retry?.id && message.role === 'assistant')).toBe(false);
    await ui.assertMessages(messages);
  });
});

test('E2E-005 专业问题的条件与局限、无关内容的引导', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我是中国人，想搬到葡萄牙生活。');
  await ui.settled(id);
  await ui.send('我能不能申请葡萄牙签证？');
  await ui.settled(id);
  const professional = await ui.latestAssistant(id);
  const notice = professional.payload!.notices.find(notice => notice.kind === 'professional');
  expect(notice?.conditions).toEqual(expect.arrayContaining([
    expect.objectContaining({ known: true, display: '中国' }), expect.objectContaining({ known: false }),
  ]));
  await expect(page.getByTestId(TID.message(professional.seq)).getByTestId(TID.notice('professional'))).toContainText('持牌专业人士');
  await expect(page.getByTestId(TID.message(professional.seq)).getByTestId(TID.notice('professional'))).toContainText('待了解');
  const profile = (await ui.detail(id)).conversation.profile;
  await ui.send('给我讲个宇宙笑话');
  await ui.settled(id);
  const unrelated = await ui.latestAssistant(id);
  await expect(page.getByTestId(TID.message(unrelated.seq)).getByTestId(TID.notice('off_topic'))).toContainText('出海计划');
  expect((await ui.detail(id)).conversation.profile).toEqual(profile);
});

test.describe('远程假服务', () => {
  test.use({ appEnv: { LLM_API_KEY: 'qa-fake-key', LLM_MODEL: 'qa-model' } });
  test('E2E-006 坏 JSON 回退至规则并显示过程', async ({ page, app }) => {
    app.fakeRemote.setBehavior({ kind: 'raw', content: 'not-json' });
    const ui = new WorkspacePage(page);
    await ui.login();
    const id = await ui.send('我是中国人，想搬到葡萄牙生活。');
    await ui.settled(id);
    const assistant = await ui.latestAssistant(id);
    expect(assistant.payload!.process.engineUsed).toBe('rules');
    expect(assistant.payload!.process.fallbacks).toEqual(expect.arrayContaining([{ engine: 'remote', reason: 'invalid_output' }]));
    expect(app.fakeRemote.requests.some(request => request.method === 'POST' && request.path === '/v1/chat/completions')).toBe(true);
    const process = page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.processInfo);
    await expect(process).toContainText('已回退到规则');
    await process.click();
    await expect(process).toContainText(/远程|remote|DeepSeek/);
    await expect(process).toContainText(/invalid_output|无效|格式|输出/);
    await expect(process).toContainText(/ms|毫秒/);
    expect((await ui.detail(id)).conversation.profile.slots.applicantNationality.value).toBe('CN');
  });
});

test('E2E-007 提前生成确认、未知项与通用国家清单', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我是中国人，想搬到智利生活。');
  const detail = await ui.settled(id);
  expect(detail.conversation.progress.canGenerateEarly).toBe(true);
  expect(detail.conversation.progress.isComplete).toBe(false);
  await expect(page.getByTestId(TID.notice('unsupported_destination'))).toContainText('通用');
  await page.getByTestId(TID.generateEarly).click();
  await expect(page.getByTestId(TID.generateDialog)).toContainText('不能再补充');
  await expect(page.getByTestId(TID.generateDialog)).toContainText('当前居住国');
  await page.getByTestId(TID.generateCancel).click();
  expect((await ui.detail(id)).plan).toBeNull();
  await page.getByTestId(TID.generateEarly).click();
  await page.getByTestId(TID.generateConfirm).click();
  await expect.poll(async () => (await ui.detail(id)).plan?.id).toBeTruthy();
  const planId = (await ui.detail(id)).plan!.id;
  await page.goto(`/plans/${planId}`);
  await ui.live();
  const plan = planResponseSchema.parse(await (await page.request.get(`/api/plans/${planId}`)).json()).plan;
  expect(plan.content).toMatchObject({ generatedEarly: true, destination: 'CL', coverage: 'generic' });
  expect(plan.content.profileSummary.unknown.map(item => item.slot)).toContain('currentResidence');
  await expect(page.getByTestId(TID.planUnknown)).toContainText('当前居住国');
  await expect(page.getByTestId(TID.planToConfirm)).not.toBeEmpty();
  await expect(page.getByTestId(TID.planDisclaimer)).toContainText('不能替代持牌专业人士');
  await page.getByTestId(TID.plansNav).click();
  await expect(page.getByTestId(TID.planCard(planId))).toContainText('通用准备清单');
});

test('E2E-008 快捷答案只更新所属槽位，过程显示快捷回答', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我和配偶想搬到葡萄牙生活。');
  await ui.settled(id);
  const before = (await ui.detail(id)).conversation.profile;
  expect(before.pendingSlots).toContain('applicantNationality');
  expect(before.pendingSlots).toContain('partnerNationality');
  await ui.quick(id, 'applicantNationality', 'CN');
  const after = (await ui.detail(id)).conversation.profile;
  expect(after.slots.applicantNationality.value).toBe('CN');
  expect(after.slots.partnerNationality).toEqual(before.slots.partnerNationality);
  expect(after.slots.currentResidence).toEqual(before.slots.currentResidence);
  const assistant = await ui.latestAssistant(id);
  expect(assistant.payload!.process.engineUsed).toBeNull();
  await expect(page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.processInfo)).toContainText('快捷回答');
});

test('E2E-009 只有最新助手消息的快捷选项可操作', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我想搬到葡萄牙生活。');
  await ui.settled(id);
  const previous = await ui.latestAssistant(id);
  await ui.quick(id, 'applicantNationality', 'CN');
  const oldOption = page.getByTestId(TID.message(previous.seq)).getByTestId(TID.quickReply('applicantNationality', 0));
  if (await oldOption.count()) await expect(oldOption).toBeDisabled();
  else await expect(oldOption).toHaveCount(0);
  const current = await ui.latestAssistant(id);
  expect(current.seq).toBeGreaterThan(previous.seq);
  const question = current.payload!.questions.find(question => question.options.length > 0)!;
  await expect(page.getByTestId(TID.message(current.seq)).getByTestId(TID.quickReply(question.slot, 0))).toBeEnabled();
});

test('E2E-010 发送失败重试复用标识且只建一个咨询', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const identifiers: string[] = [];
  let rejectFirst = true;
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    identifiers.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId);
    if (rejectFirst) { rejectFirst = false; await route.abort('failed'); } else await route.continue();
  });
  await page.getByTestId(TID.composerInput).fill('我想搬到葡萄牙生活。');
  await page.getByTestId(TID.composerSend).click();
  await expect(page.getByTestId(TID.messageRetrySend)).toBeVisible();
  await page.getByTestId(TID.messageRetrySend).click();
  await expect(page).toHaveURL(/\/c\/[^/]+$/);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  await ui.settled(id);
  expect(identifiers).toHaveLength(2);
  expect(identifiers[0]).toBeTruthy();
  expect(identifiers[1]).toBe(identifiers[0]);
  const list = conversationListResponseSchema.parse(await (await page.request.get('/api/conversations')).json());
  expect(list.items).toHaveLength(1);
  expect((await ui.messages(id)).items.filter(message => message.role === 'user')).toHaveLength(1);
  await expect(page.getByTestId(TID.messagePending)).toHaveCount(0);
});

test('E2E-011 路由保护、咨询不存在与退出登录', async ({ page }) => {
  await page.goto('/plans');
  await expect(page).toHaveURL(/\/login$/);
  const ui = new WorkspacePage(page);
  const username = await ui.login();
  const id = await ui.create();
  await page.goto(`/c/${randomUUID()}`);
  await expect(page.getByText('找不到这个咨询')).toBeVisible();
  await ui.open(id);
  await page.getByTestId(TID.logout).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await ui.login(username.toUpperCase());
  await expect(page.getByTestId(TID.convItem(id))).toBeVisible();
});

test.describe('界面容量限制', () => {
  test.use({ appEnv: { LIMIT_MESSAGE_CHARS: '80', LIMIT_MESSAGES_PER_CONVERSATION: '4', LIMIT_CONVERSATIONS_PER_USER: '1' } });
  test('E2E-019 空白、超长、消息满额与咨询上限提示', async ({ page }) => {
    const ui = new WorkspacePage(page);
    await ui.login();
    await page.getByTestId(TID.composerInput).fill('   ');
    await expect(page.getByTestId(TID.composerSend)).toBeDisabled();
    await page.getByTestId(TID.composerInput).fill('字'.repeat(81));
    await expect(page.getByTestId(TID.composerSend)).toBeDisabled();
    const id = await ui.send('我是中国人，想搬到葡萄牙生活。');
    await ui.settled(id);
    await ui.send('独自前往，没有孩子。');
    await ui.settled(id);
    expect((await ui.messages(id)).items).toHaveLength(4);
    await expect(page.getByTestId(TID.composerFullBanner)).toContainText('已达上限');
    await expect(page.getByTestId(TID.composerInput)).toHaveCount(0);
    const newConversation = page.getByTestId(TID.newConversation);
    if (!(await newConversation.isDisabled())) {
      await newConversation.click();
      await page.getByTestId(TID.composerInput).fill('我想去葡萄牙生活。');
      await page.getByTestId(TID.composerSend).click();
    }
    await expect(page.getByText(/咨询.*上限|会话.*上限/)).toBeVisible();
    expect(conversationListResponseSchema.parse(await (await page.request.get('/api/conversations')).json()).items).toHaveLength(1);
  });
});

test('E2E-020 引擎偏好保存且下一轮使用选定规则引擎', async ({ page }) => {
  const ui = new WorkspacePage(page);
  await ui.login();
  const id = await ui.send('我想搬到葡萄牙生活。');
  await ui.settled(id);
  const engine = page.getByTestId(TID.engineSelect);
  const nativeSelect = await engine.evaluate(element => element.tagName === 'SELECT');
  if (nativeSelect) {
    // Inspect the native option, since isDisabled can retarget a wrapping label to its select.
    await expect(engine.getByRole('option', { name: 'DeepSeek' })).toHaveJSProperty('disabled', true);
    await expect(engine.getByRole('option', { name: '本地模型' })).toHaveJSProperty('disabled', true);
    await engine.selectOption('rules');
  } else {
    await engine.click();
    const remote = page.getByRole('option', { name: 'DeepSeek', exact: true }).or(page.getByRole('menuitem', { name: 'DeepSeek', exact: true }));
    const local = page.getByRole('option', { name: '本地模型', exact: true }).or(page.getByRole('menuitem', { name: '本地模型', exact: true }));
    await expect(remote).toBeDisabled();
    await expect(local).toBeDisabled();
    await page.getByRole('option', { name: '规则', exact: true }).or(page.getByRole('menuitem', { name: '规则', exact: true })).click();
  }
  await expect.poll(async () => (await ui.detail(id)).conversation.enginePreference).toBe('rules');
  await ui.send('我是中国人。');
  await ui.settled(id);
  expect((await ui.latestAssistant(id)).payload!.process).toMatchObject({ engineUsed: 'rules', fallbacks: [] });
  await page.reload();
  await ui.live();
  if (nativeSelect) await expect(page.getByTestId(TID.engineSelect)).toHaveValue('rules');
  else await expect(page.getByTestId(TID.engineSelect)).toContainText('规则');
});
