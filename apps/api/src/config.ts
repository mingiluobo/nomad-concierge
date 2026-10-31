import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();
const booleanString = z.enum(['true', 'false']).transform(value => value === 'true');
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./data/nomad.sqlite'),
  WEB_ORIGIN: z.string().default('http://localhost:5173').transform(value => value.split(',').map(origin => origin.trim())).pipe(z.array(z.string().url()).min(1)),
  SERVE_WEB_DIST: booleanString.optional(),
  LLM_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  LLM_MODEL: z.string().min(1).default('deepseek-chat'),
  LLM_API_KEY: z.string().default(''),
  LLM_TIMEOUT_MS: positiveInteger.default(15000),
  LOCAL_LLM_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  LOCAL_LLM_MODEL: z.string().default(''),
  LOCAL_LLM_TIMEOUT_MS: positiveInteger.default(30000),
  TURN_TIMEOUT_MS: positiveInteger.default(60000),
  TURN_CONCURRENCY: positiveInteger.default(4),
  DEMO_DELAY_MS: z.coerce.number().int().nonnegative().default(0).transform(value => Math.min(value, 10000)),
  BREAKER_FAILURES: positiveInteger.default(3),
  BREAKER_COOLDOWN_MS: positiveInteger.default(60000),
  LIMIT_MESSAGE_CHARS: positiveInteger.default(2000),
  LIMIT_MESSAGES_PER_CONVERSATION: z.coerce.number().int().min(2).default(200),
  LIMIT_CONVERSATIONS_PER_USER: positiveInteger.default(50),
  LLM_RECENT_MESSAGES: positiveInteger.default(6),
  TOKENS_PER_USER: positiveInteger.default(10),
}).superRefine((value, context) => {
  if (value.TURN_TIMEOUT_MS <= value.LLM_TIMEOUT_MS + value.LOCAL_LLM_TIMEOUT_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['TURN_TIMEOUT_MS'], message: 'TURN_TIMEOUT_MS must exceed LLM_TIMEOUT_MS + LOCAL_LLM_TIMEOUT_MS' });
  }
});
export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environmentSchema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV, port: value.PORT, databasePath: value.DATABASE_PATH,
    webOrigins: value.WEB_ORIGIN, serveWebDist: value.SERVE_WEB_DIST ?? value.NODE_ENV === 'production',
    llmBaseUrl: value.LLM_BASE_URL, llmModel: value.LLM_MODEL, llmApiKey: value.LLM_API_KEY, llmTimeoutMs: value.LLM_TIMEOUT_MS,
    localLlmBaseUrl: value.LOCAL_LLM_BASE_URL, localLlmModel: value.LOCAL_LLM_MODEL, localLlmTimeoutMs: value.LOCAL_LLM_TIMEOUT_MS,
    turnTimeoutMs: value.TURN_TIMEOUT_MS, turnConcurrency: value.TURN_CONCURRENCY, demoDelayMs: value.DEMO_DELAY_MS,
    breakerFailures: value.BREAKER_FAILURES, breakerCooldownMs: value.BREAKER_COOLDOWN_MS,
    limitMessageChars: value.LIMIT_MESSAGE_CHARS, limitMessagesPerConversation: value.LIMIT_MESSAGES_PER_CONVERSATION,
    limitConversationsPerUser: value.LIMIT_CONVERSATIONS_PER_USER, llmRecentMessages: value.LLM_RECENT_MESSAGES, tokensPerUser: value.TOKENS_PER_USER,
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
