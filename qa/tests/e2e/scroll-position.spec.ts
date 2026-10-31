import type { ElementHandle, Page, TestInfo, WebSocketRoute } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import { WorkspacePage, deferred } from '../../fixtures/pages.js';
import { TID } from '../../../packages/shared/src/testids.js';
import { messagesResponseSchema } from '../../../packages/shared/src/dto.js';

type Scrollport = ElementHandle<HTMLElement>;
type Geometry = { top: number; height: number; viewport: number; max: number; distance: number };
type Frame = Geometry & { time: number };
type Anchor = { seq: number; offset: number; height: number };

// Discover the user-visible scrollport through the public message element and DOM
// layout only. No implementation selector, component state or scroll method is patched.
async function scrollport(page: Page, seq: number): Promise<Scrollport> {
  const handle = await page.getByTestId(TID.message(seq)).evaluateHandle(message => {
    for (let node = message.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    const root = document.scrollingElement;
    if (root instanceof HTMLElement && root.scrollHeight > root.clientHeight + 1) return root;
    throw new Error('The populated conversation has no observable scrolling ancestor');
  });
  return handle.asElement() as Scrollport;
}

async function geometry(port: Scrollport): Promise<Geometry> {
  return port.evaluate(node => {
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    return { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, max, distance: max - node.scrollTop };
  });
}

async function stable(port: Scrollport) {
  let previous: Geometry | undefined;
  let unchangedSince = 0;
  await expect.poll(async () => {
    const next = await geometry(port);
    if (!previous || Math.abs(next.top - previous.top) > 0.5 || next.height !== previous.height || next.viewport !== previous.viewport) unchangedSince = Date.now();
    previous = next;
    return Date.now() - unchangedSince;
  }, { message: 'Conversation geometry stops changing after rendering and smooth scrolling', intervals: [16, 32, 50] }).toBeGreaterThanOrEqual(200);
  return geometry(port);
}

async function longViewport(port: Scrollport) {
  const current = await stable(port);
  if (current.max <= 800) throw new Error('BLOCKED: The genuine rendered history does not provide an 800px scroll range for the distant-position precondition.');
  return current;
}

function assertSmooth(frames: Frame[], before: Geometry, after: Geometry, label: string) {
  expect(after.top - before.top, `${label}: the appended message requires a meaningful downward movement`).toBeGreaterThan(4);
  const intermediate = frames.filter(frame => frame.top > before.top + 2 && frame.top < after.top - 2);
  expect(intermediate.length, `${label}: at least one observed animation frame lies between the initial and final positions`).toBeGreaterThan(0);
}

function firstSnapshot(page: Page, id: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === `/api/conversations/${id}/messages` && !url.searchParams.has('before');
  }).then(async response => {
    expect(response.status()).toBe(200);
    return messagesResponseSchema.parse(await response.json());
  });
}

async function position(port: Scrollport, distance: number) {
  await port.evaluate((node, gap) => node.scrollTo({ top: Math.max(0, node.scrollHeight - node.clientHeight - gap), behavior: 'instant' }), distance);
  return stable(port);
}

async function bottom(port: Scrollport) {
  await expect.poll(async () => (await geometry(port)).distance, { message: 'The conversation reaches its actual bottom' }).toBeLessThanOrEqual(2);
  const result = await stable(port);
  expect(result.distance).toBeLessThanOrEqual(2);
  return result;
}

async function observe(port: Scrollport) {
  const tracker = await port.evaluateHandle(node => {
    const state = { frames: [] as Frame[], stopped: false, frameId: 0 };
    const sample = () => {
      if (state.stopped) return;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      state.frames.push({ time: performance.now(), top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, max, distance: max - node.scrollTop });
      state.frameId = requestAnimationFrame(sample);
    };
    sample();
    return state;
  });
  return async () => {
    const frames = await tracker.evaluate(state => {
      state.stopped = true;
      cancelAnimationFrame(state.frameId);
      return state.frames;
    });
    await tracker.dispose();
    return frames;
  };
}

async function readingAnchor(page: Page, port: Scrollport, seqs: number[]): Promise<Anchor> {
  const ids = seqs.map(seq => ({ seq, tid: TID.message(seq) }));
  return port.evaluate((node, candidates) => {
    const edge = node.getBoundingClientRect();
    for (const candidate of candidates) {
      const message = document.querySelector<HTMLElement>(`[data-testid="${candidate.tid}"]`);
      if (!message || !node.contains(message)) continue;
      const rect = message.getBoundingClientRect();
      if (rect.bottom > edge.top + 8 && rect.top < edge.bottom - 8) return { seq: candidate.seq, offset: rect.top - edge.top, height: rect.height };
    }
    throw new Error('No known message intersects the conversation reading viewport');
  }, ids);
}

async function offset(page: Page, port: Scrollport, anchor: Anchor) {
  const edge = await port.evaluate(node => node.getBoundingClientRect().top);
  const message = await page.getByTestId(TID.message(anchor.seq)).boundingBox();
  expect(message, 'The same reading anchor remains rendered').not.toBeNull();
  return message!.y - edge;
}

async function retained(page: Page, port: Scrollport, anchor: Anchor) {
  const result = await stable(port);
  expect(Math.abs(await offset(page, port, anchor) - anchor.offset), 'The same message stays at the same viewport offset (2px rounding tolerance)').toBeLessThanOrEqual(2);
  expect(result.distance).toBeGreaterThan(80);
  return result;
}

async function evidence(info: TestInfo, value: unknown) {
  await info.attach('scroll-geometry', { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

async function history(ui: WorkspacePage, rounds = 10, opening = '我是中国人，想搬到葡萄牙生活。') {
  const id = await ui.create(opening);
  for (let index = 0; index < rounds; index += 1) {
    await ui.post(id, `计划时间是${index % 2 ? '明年' : '下个月'}。`);
    await ui.settled(id);
  }
  const messages = (await ui.messages(id)).items;
  expect(messages).toHaveLength(2 * (rounds + 1));
  return { id, messages };
}

// Queue only real server frames, in their original order. This separates the
// external user's message from the assistant reply without manufacturing either.
class AssistantGate {
  conversation: string | undefined;
  holding = false;
  pending: Array<{ client: WebSocketRoute; data: string | Buffer }> = [];
  async attach(page: Page) {
    await page.routeWebSocket('**/ws', client => {
      const server = client.connectToServer();
      client.onMessage(data => server.send(data));
      server.onMessage(data => {
        let isAssistant = false;
        try {
          const event = JSON.parse(typeof data === 'string' ? data : data.toString()) as {
            type?: string; eventType?: string; payload?: { message?: { conversationId?: string; role?: string } };
          };
          isAssistant = event.type === 'event' && event.eventType === 'message.created'
            && event.payload?.message?.conversationId === this.conversation && event.payload?.message?.role === 'assistant';
        } catch { /* Preserve non-JSON traffic too. */ }
        if (this.holding || isAssistant) { this.holding = true; this.pending.push({ client, data }); }
        else client.send(data);
      });
      client.onClose((code, reason) => server.close({ code, reason }));
      server.onClose((code, reason) => client.close({ code, reason }));
    });
  }
  release() {
    this.conversation = undefined;
    this.holding = false;
    for (const { client, data } of this.pending.splice(0)) client.send(data);
  }
}

test('E2E-032 本标签远离底部发送仍平滑滚动到底部', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const gate = new AssistantGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const { id, messages } = await history(ui);
  await ui.open(id);
  const port = await scrollport(page, messages.at(-1)!.seq);
  const initial = await longViewport(port);
  const before = await position(port, initial.max * 0.65);
  expect(before.distance).toBeGreaterThan(80);
  let stop: (() => Promise<Frame[]>) | undefined = await observe(port);
  let frames: Frame[] = [];
  let after: Geometry | undefined;
  let afterAssistant: Geometry | undefined;
  try {
    gate.conversation = id;
    await ui.send('计划时间改成明年，请继续整理准备事项。');
    await ui.settled(id);
    const all = (await ui.messages(id)).items;
    const user = all.at(-2)!;
    const assistant = all.at(-1)!;
    await expect.poll(() => gate.holding).toBe(true);
    await expect(page.getByTestId(TID.message(user.seq))).toHaveCount(1);
    await expect(page.getByTestId(TID.message(assistant.seq))).toHaveCount(0);
    after = await bottom(port);
    frames = await stop();
    stop = undefined;
    // The user's scroll completes while the genuine assistant event is held.
    // Once released, the observer is near the bottom and may follow that reply.
    gate.release();
    await expect(page.getByTestId(TID.message(assistant.seq))).toHaveCount(1);
    afterAssistant = await bottom(port);
  } finally {
    gate.release();
    if (stop) frames = await stop();
    await evidence(info, { before, after, afterAssistant, frames });
  }
  const intermediate = frames.filter(frame => frame.top > before.top + 4 && frame.top < before.max - 4);
  expect(intermediate.length, 'Animation frames include positions between the initial reading position and the old bottom, rather than one instantaneous jump').toBeGreaterThanOrEqual(2);
  expect(intermediate.at(-1)!.time - intermediate[0]!.time).toBeGreaterThan(0);
});

test('E2E-033 其他标签消息和助手回复仅在距底部小于80px时跟随', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const gate = new AssistantGate();
  await gate.attach(page);
  const ui = new WorkspacePage(page);
  await ui.login();
  const { id, messages } = await history(ui);
  await ui.open(id);
  const port = await scrollport(page, messages.at(-1)!.seq);
  const otherPage = await context.newPage();
  const other = new WorkspacePage(otherPage);
  await other.open(id);
  // The observing tab stays foreground so requestAnimationFrame is not throttled.
  await page.bringToFront();
  const records: unknown[] = [];
  try {
    for (const near of [true, false]) {
      const current = await longViewport(port);
      const beforeUser = await position(port, near ? 40 : current.max * 0.65);
      if (near) expect(beforeUser.distance).toBeLessThan(80);
      else expect(beforeUser.distance).toBeGreaterThan(80);
      const allBefore = (await ui.messages(id)).items;
      const anchor = await readingAnchor(page, port, allBefore.map(message => message.seq));
      const record: {
        near: boolean; anchor: Anchor; beforeUser: Geometry; afterUser?: Geometry;
        beforeAssistant?: Geometry; afterAssistant?: Geometry; userSeq?: number; assistantSeq?: number;
        userFrames: Frame[]; assistantFrames: Frame[];
      } = { near, anchor, beforeUser, userFrames: [], assistantFrames: [] };
      records.push(record);
      let stage: 'userFrames' | 'assistantFrames' = 'userFrames';
      let stopStage: (() => Promise<Frame[]>) | undefined = await observe(port);
      try {
        gate.conversation = id;
        // A genuine second-tab UI send is observable separately from its held reply.
        await other.send(`计划时间是明年。${'补充说明：请继续按已知条件整理需要准备的资料。'.repeat(25)}`);
        await page.bringToFront();
        await ui.settled(id);
        const all = (await ui.messages(id)).items;
        const user = all.at(-2)!;
        const assistant = all.at(-1)!;
        expect(user.role).toBe('user');
        expect(assistant.role).toBe('assistant');
        record.userSeq = user.seq;
        record.assistantSeq = assistant.seq;
        await expect.poll(() => gate.holding, { message: 'The real assistant event is retained after the real user event' }).toBe(true);
        await expect(page.getByTestId(TID.message(user.seq))).toHaveCount(1);
        await expect(page.getByTestId(TID.message(assistant.seq))).toHaveCount(0);
        record.afterUser = near ? await bottom(port) : await retained(page, port, anchor);
        record.userFrames = await stopStage();
        stopStage = undefined;
        if (near) assertSmooth(record.userFrames, beforeUser, record.afterUser, 'Other-tab user message');
        record.beforeAssistant = near ? await position(port, 40) : await stable(port);
        stage = 'assistantFrames';
        stopStage = await observe(port);
        gate.release();
        await expect(page.getByTestId(TID.message(assistant.seq))).toHaveCount(1);
        record.afterAssistant = near ? await bottom(port) : await retained(page, port, anchor);
        record.assistantFrames = await stopStage();
        stopStage = undefined;
        if (near) assertSmooth(record.assistantFrames, record.beforeAssistant, record.afterAssistant, 'Assistant reply');
      } finally {
        if (stopStage) record[stage] = await stopStage();
        gate.release();
      }
    }
  } finally {
    gate.release();
    await evidence(info, records);
    await otherPage.close();
  }
});

test('E2E-034 顶部自动翻页prepend后保持原消息阅读锚点', async ({ page }, info) => {
  test.setTimeout(180_000);
  const ui = new WorkspacePage(page);
  await ui.login();
  const { id, messages } = await history(ui, 17);
  const snapshotPromise = firstSnapshot(page, id);
  await ui.open(id);
  const snapshot = await snapshotPromise;
  if (snapshot.nextCursor === null) throw new Error('BLOCKED: The genuine initial message snapshot has no older page; the prepend precondition is unavailable.');
  const current = snapshot.items;
  for (const message of current) await expect(page.getByTestId(TID.message(message.seq))).toHaveCount(1);
  await expect(page.getByTestId(TID.message(1))).toHaveCount(0);
  const port = await scrollport(page, current.at(-1)!.seq);
  await stable(port);
  const release = deferred();
  let captured = false;
  let delivered = false;
  let older: Awaited<ReturnType<WorkspacePage['messages']>> | undefined;
  const pattern = `**/api/conversations/${id}/messages?*`;
  await page.route(pattern, async route => {
    if (!new URL(route.request().url()).searchParams.has('before')) { await route.continue(); return; }
    const response = await route.fetch();
    older = messagesResponseSchema.parse(await response.json());
    captured = true;
    await release.promise;
    await route.fulfill({ response });
    delivered = true;
  });
  let before: Geometry | undefined;
  let after: Geometry | undefined;
  let anchor: Anchor | undefined;
  try {
    await port.evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => captured, { message: 'Scrolling to the top automatically requests real older messages without clicking load-more' }).toBe(true);
    before = await stable(port);
    anchor = await readingAnchor(page, port, current.map(message => message.seq));
    release.resolve();
    await expect.poll(() => delivered).toBe(true);
    for (const message of [...current, ...older!.items]) await expect(page.getByTestId(TID.message(message.seq))).toHaveCount(1);
    after = await retained(page, port, anchor);
    expect(after.top).toBeGreaterThan(before.top + 80);
    if (older!.nextCursor === null) await expect(page.getByTestId(TID.loadOlder)).toHaveCount(0);
  } finally {
    release.resolve();
    await evidence(info, { before, after, anchor, initialSeqs: current.map(message => message.seq), olderSeqs: older?.items.map(message => message.seq), totalDurable: messages.length });
    await page.unroute(pattern);
  }
});

test('E2E-035 切换咨询后旧翻页异步响应不改变新咨询定位', async ({ page }, info) => {
  test.setTimeout(240_000);
  const ui = new WorkspacePage(page);
  await ui.login();
  const old = await history(ui, 17);
  const fresh = await history(ui, 10, '我是日本人，想搬到智利生活。');
  const oldSnapshotPromise = firstSnapshot(page, old.id);
  await ui.open(old.id);
  if ((await oldSnapshotPromise).nextCursor === null) throw new Error('BLOCKED: The old conversation has no genuine older page to delay.');
  const oldPort = await scrollport(page, old.messages.at(-1)!.seq);
  await stable(oldPort);
  const release = deferred();
  let captured = false;
  let delivered = false;
  let requestCancelled = false;
  const pattern = `**/api/conversations/${old.id}/messages?*`;
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.pathname === `/api/conversations/${old.id}/messages` && url.searchParams.has('before')
      && /abort|cancel/i.test(request.failure()?.errorText ?? '')) requestCancelled = true;
  });
  await page.route(pattern, async route => {
    if (!new URL(route.request().url()).searchParams.has('before')) { await route.continue(); return; }
    const response = await route.fetch();
    captured = true;
    await release.promise;
    try { await route.fulfill({ response }); }
    catch (error) {
      // Cancelling an obsolete request is also a valid isolation strategy. Only
      // an observed browser cancellation can excuse a failed delivery attempt.
      if (!requestCancelled) throw error;
    }
    finally { delivered = true; }
  });
  let before: Geometry | undefined;
  let after: Geometry | undefined;
  let anchor: Anchor | undefined;
  let stop: (() => Promise<Frame[]>) | undefined;
  let frames: Frame[] = [];
  try {
    await oldPort.evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => captured).toBe(true);
    // Client-side navigation deliberately leaves the old real HTTP request pending.
    const freshSnapshotPromise = firstSnapshot(page, fresh.id);
    await page.getByTestId(TID.convItem(fresh.id)).click();
    await expect(page).toHaveURL(new RegExp(`/c/${fresh.id}$`));
    const freshSnapshot = await freshSnapshotPromise;
    await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('日本');
    await expect(page.getByTestId(TID.profileSlot('destination'))).toContainText('智利');
    await expect(page.getByTestId(TID.message(fresh.messages.at(-1)!.seq))).toHaveCount(1);
    const freshPort = await scrollport(page, fresh.messages.at(-1)!.seq);
    const current = await longViewport(freshPort);
    const initialCounts = await Promise.all(fresh.messages.map(async message => ({ seq: message.seq, count: await page.getByTestId(TID.message(message.seq)).count() })));
    const loadOlderCount = await page.getByTestId(TID.loadOlder).count();
    before = await position(freshPort, current.max * 0.65);
    anchor = await readingAnchor(page, freshPort, fresh.messages.map(message => message.seq));
    stop = await observe(freshPort);
    release.resolve();
    await expect.poll(() => delivered).toBe(true);
    await retained(page, freshPort, anchor);
    // A subsequent real assistant DOM update is a positive processing boundary;
    // an arbitrary sleep cannot establish that the late response was handled.
    await ui.post(fresh.id, '计划时间是明年。');
    await ui.settled(fresh.id);
    const last = await ui.latestAssistant(fresh.id);
    await expect(page.getByTestId(TID.message(last.seq))).toHaveCount(1);
    after = await retained(page, freshPort, anchor);
    for (const item of initialCounts) await expect(page.getByTestId(TID.message(item.seq))).toHaveCount(item.count);
    for (const message of freshSnapshot.items.filter(message => message.role === 'user')) await expect(page.getByTestId(TID.message(message.seq))).toContainText(message.content);
    await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('日本');
    await expect(page.getByTestId(TID.loadOlder)).toHaveCount(loadOlderCount);
    frames = await stop();
    stop = undefined;
    expect(Math.max(...frames.map(frame => Math.abs(frame.top - before!.top))), 'No transient old-conversation scroll adjustment reaches the new reading position').toBeLessThanOrEqual(2);
  } finally {
    release.resolve();
    if (stop) frames = await stop();
    await evidence(info, { before, after, anchor, frames, captured, delivered, requestCancelled });
    await page.unroute(pattern);
  }
});
