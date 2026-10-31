const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export const numberPattern = '[零〇一二两三四五六七八九十\\d]+';
export function chineseNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (text in digits) return digits[text]!;
  const match = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  return match ? (match[1] ? digits[match[1]]! : 1) * 10 + (match[2] ? digits[match[2]]! : 0) : null;
}
