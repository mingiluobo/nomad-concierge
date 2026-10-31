import { useState } from 'react';
import { TID, slots } from '@nomad/shared';
import type { AssistantPayload, SlotKey, UserPayload } from '@nomad/shared';

export const engineNames: Record<string, string> = { auto: '自动', remote: 'DeepSeek', local: '本地模型', rules: '规则' };
const reasons: Record<string, string> = { unavailable: '不可用', timeout: '超时', invalid_output: '输出不合格', circuit_open: '熔断中', error: '调用失败' };
export function AssistantMessage({ payload, enabled, onAnswer, onInput }: { payload: AssistantPayload; enabled: boolean; onAnswer(content: string, payload: UserPayload): void; onInput(slot: SlotKey): void }) {
  const [goals, setGoals] = useState<string[]>([]);
  const process = payload.process;
  const engine = process.engineUsed === null ? '快捷回答' : engineNames[process.engineUsed];
  const processSummary = process.fallbacks.length > 0 && process.engineUsed ? `已回退到${engine}` : `${engine} · ${Math.round(process.timings.totalMs ?? 0)}ms`;
  return <>
    {payload.notices.map((notice, index) => <div className={`notice notice-${notice.kind}`} data-testid={TID.notice(notice.kind)} key={`${notice.kind}-${index}`}><p>{notice.text}</p>{notice.conditions && <ul>{notice.conditions.map((condition, item) => <li key={item}>{condition.label}：{condition.known ? condition.display ?? '已了解' : '待了解'}</li>)}</ul>}</div>)}
    {!!payload.recorded.length && <div className="recorded"><span className="small-label">已记录</span><div className="chips">{payload.recorded.map(item => <span className="chip" key={item.slot} data-testid={TID.recordedChip(item.slot)}>{item.label} · {item.display}</span>)}</div></div>}
    {payload.corrections.map(item => <p className="correction" data-testid={TID.correction(item.slot)} key={item.slot}>✎ 已更新：{item.label} <del>{item.from}</del> → <strong>{item.to}</strong></p>)}
    {!!payload.questions.length && <div className="questions"><p className="small-label">还需要了解</p>{payload.questions.map(question => <div className="question" key={question.slot}><p>{question.text}</p><div className="quick-options">{question.options.map((option, index) => {
      const goal = question.slot === 'goals' && Array.isArray(option.value) ? String(option.value[0]) : undefined;
      return <button key={index} data-testid={TID.quickReply(question.slot, index)} disabled={!enabled} aria-pressed={goal ? goals.includes(goal) : undefined} onClick={() => goal ? setGoals(current => current.includes(goal) ? current.filter(item => item !== goal) : [...current, goal]) : onAnswer(option.label, { answers: [{ slot: question.slot, value: option.value, label: option.label }] })}>{goal ? (goals.includes(goal) ? '✓ ' : '＋ ') : ''}{option.label}</button>;
    })}{slots[question.slot].inputLabels?.map((label, index) => <button key={`input-${index}`} data-testid={`quick-input-${question.slot}-${index}`} disabled={!enabled} onClick={() => onInput(question.slot)}>{label}</button>)}</div>{question.slot === 'goals' && <button className="text-button confirm-goals" data-testid="quick-reply-goals-submit" disabled={!enabled || !goals.length} onClick={() => { const label = slots.goals.format(goals); onAnswer(label, { answers: [{ slot: 'goals', value: goals, label }] }); setGoals([]); }}>确认选择</button>}</div>)}</div>}
    <details className="process" data-testid={TID.processInfo}><summary data-testid="process-info-toggle">{processSummary}</summary><div><p>理解引擎：{engine}</p>{process.fallbacks.map((fallback, index) => <p key={index}>{engineNames[fallback.engine]}：{reasons[fallback.reason] ?? fallback.reason}</p>)}{Object.entries(process.timings).map(([key, value]) => <p key={key}>{({ queuedMs: '排队', understandingMs: '理解', decidingMs: '决定下一步', replyingMs: '回复', totalMs: '总计' } as Record<string, string>)[key]}：{Math.round(value)}ms</p>)}{process.promptVersion && <p>提示词版本：{process.promptVersion}</p>}</div></details>
  </>;
}
