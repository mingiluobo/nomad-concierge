import { useState } from 'react';
import { TID, slotDefinitions, slots } from '@nomad/shared';
import type { ConversationDetailDto, Profile, SlotKey } from '@nomad/shared';

function applicable(key: SlotKey, profile: Profile): boolean {
  if (key === 'partnerNationality' && profile.slots.hasPartner.status === 'known' && profile.slots.hasPartner.value === false) return false;
  if (['childrenAges', 'schoolPreference'].includes(key) && profile.slots.childrenCount.status === 'known' && profile.slots.childrenCount.value === 0) return false;
  return true;
}
export function ProfilePanel({ conversation, onGenerate, busy, activeTurn }: { conversation: ConversationDetailDto; onGenerate(early: boolean): void; busy: boolean; activeTurn: boolean }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('nc-profile-collapsed') === 'true'; } catch { return false; } });
  const [confirmEarly, setConfirmEarly] = useState<boolean | null>(null);
  const [hint, setHint] = useState('');
  const progress = conversation.progress;
  const profile = conversation.profile;
  function generate(early: boolean) {
    if (activeTurn) { setHint('正在回复，请稍候。'); return; }
    setHint('');
    setConfirmEarly(early);
  }
  const needed = (['destination', 'goals', 'applicantNationality'] as SlotKey[]).filter(key => profile.slots[key].status !== 'known').map(key => slots[key].label);
  return <aside className={`profile-panel ${collapsed ? 'collapsed' : ''}`} data-testid={TID.profilePanel}>
    <div className="profile-header"><h2>{collapsed ? '档案' : '咨询档案'}</h2><button className="text-button" data-testid="profile-toggle" aria-expanded={!collapsed} aria-label={collapsed ? '展开咨询档案' : '收起咨询档案'} onClick={() => { setCollapsed(!collapsed); try { localStorage.setItem('nc-profile-collapsed', String(!collapsed)); } catch { /* Storage is optional. */ } }}>{collapsed ? '‹' : '›'}</button></div>
    {!collapsed && <><div className="profile-progress" data-testid={TID.profileProgress}><div><span>信息完整度</span><strong>{progress.answered} / {progress.required}</strong></div><progress value={progress.answered} max={progress.required || 1} /></div><div className="profile-fields">{(['base', 'goal'] as const).map(group => <section key={group}><h3>{group === 'base' ? '基础信息' : '按诉求'}</h3>{slotDefinitions.filter(definition => definition.group === group && applicable(definition.key, profile)).map(definition => {
      const slot = profile.slots[definition.key];
      return <div className={`profile-field slot-${slot.status}`} data-testid={TID.profileSlot(definition.key)} key={definition.key}><span>{definition.label}</span><strong title={slot.corrected && slot.previousValue !== undefined ? `原为 ${definition.format(slot.previousValue)}` : undefined}>{slot.status === 'known' ? `${slot.corrected ? '✎ ' : ''}${definition.format(slot.value)}` : slot.status === 'unsure' ? '不确定' : '待了解'}</strong></div>;
    })}</section>)}</div>{conversation.status === 'collecting' && <div className="profile-footer">{progress.isComplete ? <button className="primary" data-testid={TID.generatePlan} disabled={busy} onClick={() => generate(false)}>{busy ? '正在生成…' : '生成计划 →'}</button> : progress.canGenerateEarly ? <button data-testid={TID.generateEarly} disabled={busy} onClick={() => generate(true)}>信息不全也可以先生成</button> : <p className="muted">还需要：{needed.join('、')}</p>}{hint && <p role="status">{hint}</p>}</div>}</>}
    {confirmEarly !== null && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="generate-title" data-testid={TID.generateDialog}><h2 id="generate-title">现在生成初步计划？</h2>{confirmEarly && <><p>以下信息还未了解，会在计划里标明：</p><ul>{progress.missing.map(key => <li key={key}>{slots[key].label}</li>)}</ul></>}<p className="notice">生成后这个咨询会结束，不能再补充。</p><div className="dialog-actions"><button data-testid={TID.generateCancel} onClick={() => setConfirmEarly(null)}>继续补充</button><button className="primary" data-testid={TID.generateConfirm} disabled={busy} onClick={() => { setConfirmEarly(null); if (activeTurn) { setHint('正在回复，请稍候。'); return; } onGenerate(confirmEarly); }}>{confirmEarly ? '仍然生成' : '生成计划'}</button></div></section></div>}
  </aside>;
}
