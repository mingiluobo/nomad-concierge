import { z } from 'zod';
import {
  loginResponseSchema, meResponseSchema, enginesResponseSchema, conversationListResponseSchema,
  conversationResponseSchema, createConversationResponseSchema, updateConversationResponseSchema,
  messagesResponseSchema, postMessageResponseSchema, turnResponseSchema, readResponseSchema,
  planResponseSchema, plansResponseSchema,
} from '@nomad/shared';
import type { EnginePreference, UserPayload } from '@nomad/shared';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}
const messages: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新进入。', NOT_FOUND: '找不到这条记录。',
  CONVERSATION_COMPLETED: '这个咨询已生成计划，不能再补充。', TURN_IN_PROGRESS: '正在回复，请稍候。',
  UNPROCESSED_MESSAGES: '还有消息没处理完，请先重试这一轮。', PROFILE_INCOMPLETE: '信息还不完整，请先确认是否提前生成。',
  PROFILE_INSUFFICIENT: '请先补充目的国、诉求和本人国籍。', TURN_NOT_RETRYABLE: '只有最新的失败或中断任务可以重试。',
  MESSAGE_TOO_LONG: '消息太长，请缩短后发送。', CONVERSATION_FULL: '已达上限，可以生成计划或新建咨询。',
  CONVERSATION_LIMIT_REACHED: '咨询数量已达上限，请继续已有的咨询。', VALIDATION_ERROR: '请检查输入内容。',
  INTERNAL_ERROR: '暂时无法完成操作，请重试。', BAD_REQUEST: '请求内容无法读取，请重试。',
};
export function errorText(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] ?? error.message : '网络连接失败，请重试。';
}
export async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    throw new ApiError(response.status, payload?.error?.code ?? 'INTERNAL_ERROR', payload?.error?.message ?? '请求失败', payload?.error?.details);
  }
  return schema.parse(response.status === 204 ? undefined : await response.json());
}
const id = encodeURIComponent;
export const api = {
  me: () => request('/me', meResponseSchema),
  login: (username: string) => request('/auth/login', loginResponseSchema, { username }),
  logout: () => request('/auth/logout', z.undefined(), undefined, 'POST'),
  engines: () => request('/engines', enginesResponseSchema),
  conversations: () => request('/conversations', conversationListResponseSchema),
  conversation: (conversationId: string) => request(`/conversations/${id(conversationId)}`, conversationResponseSchema),
  createConversation: (content: string, clientMessageId: string, enginePreference: EnginePreference = 'auto') => request('/conversations', createConversationResponseSchema, { content, clientMessageId, enginePreference }),
  setEngine: (conversationId: string, enginePreference: EnginePreference) => request(`/conversations/${id(conversationId)}`, updateConversationResponseSchema, { enginePreference }, 'PATCH'),
  messages: (conversationId: string, before?: number) => request(`/conversations/${id(conversationId)}/messages${before === undefined ? '' : `?before=${before}`}`, messagesResponseSchema),
  send: (conversationId: string, content: string, clientMessageId: string, payload?: UserPayload) => request(`/conversations/${id(conversationId)}/messages`, postMessageResponseSchema, { content, clientMessageId, payload }),
  cancel: (conversationId: string, turnId: string) => request(`/conversations/${id(conversationId)}/turns/${id(turnId)}/cancel`, turnResponseSchema, undefined, 'POST'),
  retry: (conversationId: string, turnId: string) => request(`/conversations/${id(conversationId)}/turns/${id(turnId)}/retry`, turnResponseSchema, undefined, 'POST'),
  read: (conversationId: string, seq: number) => request(`/conversations/${id(conversationId)}/read`, readResponseSchema, { seq }),
  generate: (conversationId: string, allowIncomplete: boolean) => request(`/conversations/${id(conversationId)}/plan`, planResponseSchema, { allowIncomplete }),
  plans: () => request('/plans', plansResponseSchema),
  plan: (planId: string) => request(`/plans/${id(planId)}`, planResponseSchema),
};
