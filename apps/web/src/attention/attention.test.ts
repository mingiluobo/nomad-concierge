import { describe, expect, it } from 'vitest';
import { attention, favicon } from './attention';

describe('tab attention', () => {
  it.each([[0, true, true, false], [0, false, false, false], [2, true, true, false], [2, true, false, true], [2, false, true, true], [2, false, false, true]] as const)('uses unread=%s visible=%s focused=%s', (count, visible, focused, notify) => {
    expect(attention(count, visible, focused)).toEqual({ notify, title: notify ? '(2) Nomad Concierge' : 'Nomad Concierge' });
  });
  it('changes the favicon with the same attention state', () => {
    expect(decodeURIComponent(favicon(true))).toContain('<circle');
    expect(decodeURIComponent(favicon(false))).not.toContain('<circle');
  });
});
