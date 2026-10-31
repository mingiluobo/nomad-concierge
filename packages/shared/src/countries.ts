import { z } from 'zod';

export interface Country {
  code: string;
  name: string;
  aliases: string[];
  isEuEeaSwiss: boolean;
}
const entries: [string, string, string[], boolean][] = [
  ['CN', '中国', ['中国', '中国籍', '中国人', 'China', 'Chinese'], false],
  ['PT', '葡萄牙', ['葡萄牙', '葡国', '葡萄牙籍', '葡萄牙人', 'Portugal', 'Portuguese', '葡萄牙共和国'], true],
  ['ES', '西班牙', ['西班牙', 'Spain', 'Spanish', '西班牙王国'], true],
  ['FR', '法国', ['法国', 'France', 'French', '法兰西', '法兰西共和国'], true],
  ['DE', '德国', ['德国', 'Germany', 'German', '德意志', '德意志联邦共和国'], true],
  ['IT', '意大利', ['意大利', 'Italy', 'Italian', '意大利共和国'], true],
  ['NL', '荷兰', ['荷兰', 'Netherlands', 'Dutch', '荷兰王国', '尼德兰王国'], true],
  ['BE', '比利时', ['比利时', 'Belgium', 'Belgian', '比利时王国'], true],
  ['AT', '奥地利', ['奥地利', 'Austria', 'Austrian', '奥地利共和国'], true],
  ['IE', '爱尔兰', ['爱尔兰', 'Ireland', 'Irish', '爱尔兰共和国'], true],
  ['DK', '丹麦', ['丹麦', 'Denmark', 'Danish', '丹麦王国'], true],
  ['SE', '瑞典', ['瑞典', 'Sweden', 'Swedish', '瑞典王国'], true],
  ['FI', '芬兰', ['芬兰', 'Finland', 'Finnish', '芬兰共和国'], true],
  ['GR', '希腊', ['希腊', 'Greece', 'Greek', '希腊共和国'], true],
  ['PL', '波兰', ['波兰', 'Poland', 'Polish', '波兰共和国'], true],
  ['CZ', '捷克', ['捷克', 'Czechia', 'Czech', '捷克共和国'], true],
  ['HU', '匈牙利', ['匈牙利', 'Hungary', 'Hungarian'], true],
  ['RO', '罗马尼亚', ['罗马尼亚', 'Romania', 'Romanian'], true],
  ['BG', '保加利亚', ['保加利亚', 'Bulgaria', 'Bulgarian', '保加利亚共和国'], true],
  ['HR', '克罗地亚', ['克罗地亚', 'Croatia', 'Croatian', '克罗地亚共和国'], true],
  ['SK', '斯洛伐克', ['斯洛伐克', 'Slovakia', 'Slovak', '斯洛伐克共和国'], true],
  ['SI', '斯洛文尼亚', ['斯洛文尼亚', 'Slovenia', 'Slovenian', '斯洛文尼亚共和国'], true],
  ['EE', '爱沙尼亚', ['爱沙尼亚', 'Estonia', 'Estonian', '爱沙尼亚共和国'], true],
  ['LV', '拉脱维亚', ['拉脱维亚', 'Latvia', 'Latvian', '拉脱维亚共和国'], true],
  ['LT', '立陶宛', ['立陶宛', 'Lithuania', 'Lithuanian', '立陶宛共和国'], true],
  ['LU', '卢森堡', ['卢森堡', 'Luxembourg', '卢森堡大公国'], true],
  ['MT', '马耳他', ['马耳他', 'Malta', 'Maltese', '马耳他共和国'], true],
  ['CY', '塞浦路斯', ['塞浦路斯', 'Cyprus', 'Cypriot', '塞浦路斯共和国'], true],
  ['NO', '挪威', ['挪威', 'Norway', 'Norwegian', '挪威王国'], true],
  ['IS', '冰岛', ['冰岛', 'Iceland', 'Icelandic', '冰岛共和国'], true],
  ['LI', '列支敦士登', ['列支敦士登', 'Liechtenstein', '列支敦士登公国'], true],
  ['CH', '瑞士', ['瑞士', 'Switzerland', 'Swiss', '瑞士联邦'], true],
  ['GB', '英国', ['英国', 'United Kingdom', 'Britain', 'British', 'UK', '大不列颠', '大不列颠及北爱尔兰联合王国', '大不列颠和北爱尔兰联合王国'], false],
  ['US', '美国', ['美国', 'United States', 'America', 'American', 'USA', '美利坚', '美利坚合众国'], false],
  ['CA', '加拿大', ['加拿大', 'Canada', 'Canadian'], false],
  ['AU', '澳大利亚', ['澳大利亚', '澳洲', 'Australia', 'Australian', '澳大利亚联邦'], false],
  ['NZ', '新西兰', ['新西兰', 'New Zealand', '纽西兰'], false],
  ['JP', '日本', ['日本', 'Japan', 'Japanese', '日本国'], false],
  ['KR', '韩国', ['韩国', 'South Korea', 'Korean', '大韩民国'], false],
  ['SG', '新加坡', ['新加坡', 'Singapore', 'Singaporean', '新加坡共和国', '狮城'], false],
  ['MY', '马来西亚', ['马来西亚', 'Malaysia', 'Malaysian'], false],
  ['TH', '泰国', ['泰国', 'Thailand', 'Thai', '泰王国'], false],
  ['AE', '阿联酋', ['阿联酋', 'United Arab Emirates', 'UAE', '阿拉伯联合酋长国'], false],
  ['CL', '智利', ['智利', 'Chile', 'Chilean', '智利共和国'], false],
  ['BR', '巴西', ['巴西', 'Brazil', 'Brazilian', '巴西联邦共和国'], false],
];
export const countries: readonly Country[] = entries.map(([code, name, aliases, isEuEeaSwiss]) => ({ code, name, aliases, isEuEeaSwiss }));
const isoCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
export const countryCodeSchema = z.string().refine(code => isoCodes.has(code), 'Expected an ISO 3166-1 alpha-2 country code');
export const countryName = (code: string): string => countries.find(country => country.code === code)?.name ?? code;
export const isEuEeaSwiss = (code: string): boolean => countries.some(country => country.code === code && country.isEuEeaSwiss);
