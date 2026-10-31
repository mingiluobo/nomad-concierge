import { z } from 'zod';

export const errorStatus = {
  BAD_REQUEST: 400, UNAUTHENTICATED: 401, NOT_FOUND: 404,
  CONVERSATION_COMPLETED: 409, TURN_IN_PROGRESS: 409, UNPROCESSED_MESSAGES: 409, PROFILE_INCOMPLETE: 409, TURN_NOT_RETRYABLE: 409, ILLEGAL_TRANSITION: 409,
  VALIDATION_ERROR: 422, MESSAGE_TOO_LONG: 422, CONVERSATION_FULL: 422, CONVERSATION_LIMIT_REACHED: 422, PROFILE_INSUFFICIENT: 422,
  INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof errorStatus;
export const errorCodeSchema = z.enum(Object.keys(errorStatus) as [ErrorCode, ...ErrorCode[]]);
export const errorResponseSchema = z.object({ error: z.object({ code: errorCodeSchema, message: z.string(), requestId: z.string(), details: z.record(z.unknown()).optional() }) });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export const turnErrorCodeSchema = z.enum(['TURN_TIMEOUT', 'INTERNAL_ERROR', 'RECOVERY_LIMIT']);
export type TurnErrorCode = z.infer<typeof turnErrorCodeSchema>;
