import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { SlotKey, SlotUpdate } from '@nomad/shared';
import { RulesInterpreter } from '../../src/agent/rules/index.js';

const countrySlots: SlotKey[] = ['destination', 'applicantNationality', 'partnerNationality', 'currentResidence', 'incomeCountry'];
const interpret = (text: string, pendingSlots: SlotKey[] = []) => new RulesInterpreter().interpret({
  profile: createEmptyProfile(), pendingSlots, recentMessages: [], newMessages: [{ id: 'country', content: text }],
}, new AbortController().signal);

describe('country aliases in rule interpretation', () => {
  it.each([
    ['美利坚', 'US'], ['美利坚合众国', 'US'], ['大不列颠', 'GB'],
    ['德意志', 'DE'], ['德意志联邦共和国', 'DE'], ['法兰西', 'FR'], ['法兰西共和国', 'FR'],
    ['中华人民共和国', 'CN'], ['大韩民国', 'KR'], ['泰王国', 'TH'],
    ['阿拉伯联合酋长国', 'AE'], ['纽西兰', 'NZ'], ['尼德兰王国', 'NL'], ['狮城', 'SG'],
  ])('interprets %s as %s when answering the pending country question', async (alias, code) => {
    expect((await interpret(alias, ['destination'])).interpretation).toEqual({
      intent: 'provide_info', updates: [{ slot: 'destination', value: code }], unsure: [],
    });
  });
  it.each(['currentResidence', 'incomeCountry', 'partnerNationality', 'applicantNationality'] as SlotKey[])('uses the pending %s for a bare country full name', async slot => {
    expect((await interpret('中华人民共和国', [slot])).interpretation.updates).toEqual([{ slot, value: 'CN' }]);
  });
  it('does not infer nationality from a character inside a bare country name without a pending country question', async () => {
    expect((await interpret('中华人民共和国')).interpretation.updates).toEqual([]);
  });
  it.each([
    ['中国人', 'CN'], ['中国籍', 'CN'], ['葡萄牙人', 'PT'], ['葡萄牙籍', 'PT'],
    ['中华人民共和国人', 'CN'], ['中华人民共和国籍', 'CN'], ['中华人民共和国国籍', 'CN'],
    ['中华人民共和国护照', 'CN'], ['国籍中华人民共和国', 'CN'], ['护照中华人民共和国', 'CN'],
    ['我是中华人民共和国', 'CN'],
  ])('keeps the explicit nationality clue in %s', async (text, code) => {
    expect((await interpret(text, ['destination'])).interpretation.updates).toEqual([{ slot: 'applicantNationality', value: code }]);
  });
  it.each(['大不列颠及北爱尔兰联合王国', '大不列颠和北爱尔兰联合王国'])('keeps the embedded Ireland name inside %s within the UK mention', async name => {
    const result = await interpret(`前往${name}`);
    expect(result.interpretation.updates).toEqual([{ slot: 'destination', value: 'GB' }]);
    expect(result.droppedUpdates).toEqual([]);
  });
  it('still recognizes a separate Ireland mention beside the full UK name', async () => {
    const result = await interpret('现在住在大不列颠及北爱尔兰联合王国，收入来自爱尔兰共和国');
    expect(result.interpretation.updates).toEqual([
      { slot: 'currentResidence', value: 'GB' }, { slot: 'incomeCountry', value: 'IE' },
    ]);
  });
  it.each([
    ['我是美利坚合众国籍', [{ slot: 'applicantNationality', value: 'US' }]],
    ['配偶是法兰西共和国籍', [{ slot: 'partnerNationality', value: 'FR' }]],
    ['现在住在德意志联邦共和国', [{ slot: 'currentResidence', value: 'DE' }]],
    ['收入来自阿拉伯联合酋长国', [{ slot: 'incomeCountry', value: 'AE' }]],
    ['申请大不列颠及北爱尔兰联合王国签证', [{ slot: 'destination', value: 'GB' }]],
    ['配偶是德意志籍我是美利坚合众国籍目前住在法兰西共和国前往大不列颠', [
      { slot: 'partnerNationality', value: 'DE' }, { slot: 'applicantNationality', value: 'US' },
      { slot: 'currentResidence', value: 'FR' }, { slot: 'destination', value: 'GB' },
    ]],
  ] as [string, SlotUpdate[]][])('preserves country roles in %s', async (text, expected) => {
    const result = await interpret(text);
    expect(result.interpretation.updates.filter(update => countrySlots.includes(update.slot))).toEqual(expected);
    expect(result.droppedUpdates).toEqual([]);
  });
  it.each(['前往巴黎', '目前住在柏林', '收入来自北美', '前往欧洲', '前往迪拜', '前往大马士革', '参加国际会议'])('does not assign a country from %s', async text => {
    expect((await interpret(text, ['destination'])).interpretation.updates.filter(update => countrySlots.includes(update.slot))).toEqual([]);
  });
});
