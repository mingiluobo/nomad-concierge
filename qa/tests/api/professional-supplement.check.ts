import { writeFile } from 'node:fs/promises';
import { test, expect } from '../../fixtures/test.js';
import { login, create, settle, reply } from './support.js';

for (const scenario of [
  { part: 'tax', input: '我是中国籍，要交多少税？' },
  { part: 'company', input: '我是中国籍，开公司合法吗？' },
]) {
  test(`API-042 supplemental ${scenario.part}: previously unexecuted input`, async ({ api }, testInfo) => {
    testInfo.annotations.push({ type: 'scope', description: `API-042 ${scenario.part} sub-input only; does not replace the failed visa result or mark the full case passed.` });
    await login(api.request);
    const made = await create(api.request, scenario.input);
    const state = await settle(api.request, made.conversation.id);
    const last = await reply(api.request, made.conversation.id);
    const evidencePath = testInfo.outputPath(`${scenario.part}-snapshot.json`);
    await writeFile(evidencePath, JSON.stringify({ scope: scenario, candidate: process.env.QA_CANDIDATE_COMMIT, state, last }, null, 2));
    await testInfo.attach(`${scenario.part}-snapshot`, { path: evidencePath, contentType: 'application/json' });
    expect(state.conversation.profile.slots.applicantNationality.value).toBe('CN');
    const notice = last.payload.notices.find(item => item.kind === 'professional');
    expect(notice?.text).toMatch(/持牌/);
    expect(notice?.text).toMatch(/没办法给出结论|不能.*结论/);
    expect(notice?.conditions?.length).toBeGreaterThan(0);
    expect(notice?.conditions?.some(condition => !condition.known)).toBe(true);
    expect(last.payload.questions.length).toBeGreaterThan(0);
  });
}
