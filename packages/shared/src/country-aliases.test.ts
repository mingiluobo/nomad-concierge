import { describe, expect, it } from 'vitest';
import { countries } from './countries.js';

// Expected spellings and ISO codes are curated independently of the production registry.
const expectedAliases: [string, string[]][] = [
  ['CN', ['中华人民共和国']],
  ['PT', ['葡萄牙共和国']],
  ['ES', ['西班牙王国']],
  ['FR', ['法兰西', '法兰西共和国']],
  ['DE', ['德意志', '德意志联邦共和国']],
  ['IT', ['意大利共和国']],
  ['NL', ['荷兰王国', '尼德兰王国']],
  ['BE', ['比利时王国']],
  ['AT', ['奥地利共和国']],
  ['IE', ['爱尔兰共和国']],
  ['DK', ['丹麦王国']],
  ['SE', ['瑞典王国']],
  ['FI', ['芬兰共和国']],
  ['GR', ['希腊共和国']],
  ['PL', ['波兰共和国']],
  ['CZ', ['捷克共和国']],
  ['HU', ['匈牙利']],
  ['RO', ['罗马尼亚']],
  ['BG', ['保加利亚共和国']],
  ['HR', ['克罗地亚共和国']],
  ['SK', ['斯洛伐克共和国']],
  ['SI', ['斯洛文尼亚共和国']],
  ['EE', ['爱沙尼亚共和国']],
  ['LV', ['拉脱维亚共和国']],
  ['LT', ['立陶宛共和国']],
  ['LU', ['卢森堡大公国']],
  ['MT', ['马耳他共和国']],
  ['CY', ['塞浦路斯共和国']],
  ['NO', ['挪威王国']],
  ['IS', ['冰岛共和国']],
  ['LI', ['列支敦士登公国']],
  ['CH', ['瑞士联邦']],
  ['GB', ['大不列颠', '大不列颠及北爱尔兰联合王国', '大不列颠和北爱尔兰联合王国']],
  ['US', ['美利坚', '美利坚合众国']],
  ['CA', ['加拿大']],
  ['AU', ['澳大利亚联邦']],
  ['NZ', ['纽西兰']],
  ['JP', ['日本国']],
  ['KR', ['大韩民国']],
  ['SG', ['新加坡共和国', '狮城']],
  ['MY', ['马来西亚']],
  ['TH', ['泰王国']],
  ['AE', ['阿拉伯联合酋长国']],
  ['CL', ['智利共和国']],
  ['BR', ['巴西联邦共和国']],
];

describe('Chinese country aliases', () => {
  it.each(expectedAliases.flatMap(([code, aliases]) => aliases.map(alias => ({ code, alias }))))('$alias belongs only to $code', ({ code, alias }) => {
    expect(countries.filter(country => country.aliases.includes(alias)).map(country => country.code)).toEqual([code]);
  });
  it('keeps the existing 45-country coverage', () => {
    expect(countries.map(country => country.code).sort()).toEqual(expectedAliases.map(([code]) => code).sort());
    expect(countries).toHaveLength(45);
  });
  it.each(['巴黎', '柏林', '欧洲', '北美', '大和族', '马来族', '加国', '大马', '迪拜', '英格兰', '苏格兰'])('does not register the city, region, ethnicity or ambiguous shorthand %s as a country', alias => {
    expect(countries.some(country => country.aliases.includes(alias))).toBe(false);
  });
});
