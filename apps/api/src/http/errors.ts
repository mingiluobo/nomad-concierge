import { errorStatus } from '@nomad/shared';
import type { ErrorCode } from '@nomad/shared';
import type { ErrorRequestHandler } from 'express';
import type { z } from 'zod';

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status: number = errorStatus[code], message: string = code, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }
}
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 422, '请检查输入内容。', { issues: result.error.issues });
  return result.data;
}
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) { next(error); return; }
  const bodyError = typeof error === 'object' && error !== null && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type));
  const domainError = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ILLEGAL_TRANSITION';
  const known = error instanceof AppError ? error : bodyError ? new AppError('BAD_REQUEST', 400, '请求体无法解析或超过大小上限。')
    : domainError ? new AppError('ILLEGAL_TRANSITION', 409, '状态无法进行此操作。') : new AppError('INTERNAL_ERROR', 500, '暂时无法完成操作，请重试。');
  if (known.code === 'INTERNAL_ERROR') console.error('Unhandled request error', { requestId: response.locals.requestId, error });
  response.status(known.status).json({ error: { code: known.code, message: known.message, requestId: response.locals.requestId, ...(known.details ? { details: known.details } : {}) } });
};
