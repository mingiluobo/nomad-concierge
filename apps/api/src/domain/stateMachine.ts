import { conversationTransitions, turnTransitions } from '@nomad/shared';
import type { ConversationStatus, TurnStatus } from '@nomad/shared';

type Status = ConversationStatus | TurnStatus;
const transitions: Record<Status, readonly Status[]> = { ...conversationTransitions, ...turnTransitions };
export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly status = 409;
  constructor(from: Status, to: Status) { super(`Illegal state transition: ${from} -> ${to}`); this.name = 'IllegalTransitionError'; }
}
export function canTransition(from: Status, to: Status): boolean { return transitions[from].includes(to); }
export function transition(from: Status, to: Status): {
  setSql: string; setParameters: [Status]; whereSql: string; whereParameters: [Status];
} {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return { setSql: 'status = ?, version = version + 1', setParameters: [to], whereSql: 'status IN (?)', whereParameters: [from] };
}
