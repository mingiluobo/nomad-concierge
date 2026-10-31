import { Router } from 'express';
import type { Response } from 'express';
import { loginRequestSchema, createConversationRequestSchema, conversationListQuerySchema, updateConversationRequestSchema,
  messagesQuerySchema, postMessageRequestSchema, readRequestSchema, generatePlanRequestSchema } from '@nomad/shared';
import type { AppConfig } from '../config.js';
import type { InterpreterFactory } from '../composition.js';
import { tokenCookieOptions } from '../auth/service.js';
import type { AuthenticationService, AuthSession } from '../auth/service.js';
import type { ConversationService } from '../services/conversations.js';
import { parse } from '../http/errors.js';

export interface ApiRouterOptions { auth: AuthenticationService; conversations: ConversationService; engines: Pick<InterpreterFactory, 'status'>; config: AppConfig }
export function createApiRouter({ auth, conversations, engines, config }: ApiRouterOptions): Router {
  const router = Router();
  const limits = { messageChars: config.limitMessageChars, messagesPerConversation: config.limitMessagesPerConversation };
  const session = (response: Response): AuthSession => response.locals.session as AuthSession;
  router.post('/api/auth/login', (request, response) => {
    const input = parse(loginRequestSchema, request.body);
    const { user, token } = auth.login(input.username);
    response.cookie('nc_token', token, tokenCookieOptions(config.nodeEnv === 'production', request.secure)).json({ user, limits });
  });
  router.use('/api', auth.requireSession);
  router.post('/api/auth/logout', (request, response) => {
    auth.logout(session(response));
    const { maxAge: _maxAge, ...options } = tokenCookieOptions(config.nodeEnv === 'production', request.secure); void _maxAge;
    response.clearCookie('nc_token', options).status(204).end();
  });
  router.get('/api/me', (_request, response) => response.json({ user: session(response).user, limits }));
  router.get('/api/engines', (_request, response) => response.json({ engines: engines.status() }));
  router.get('/api/conversations', (request, response) => response.json(conversations.list(session(response).userId, parse(conversationListQuerySchema, request.query).status)));
  router.post('/api/conversations', (request, response) => {
    const { created, ...result } = conversations.create(session(response).userId, parse(createConversationRequestSchema, request.body));
    response.status(created ? 201 : 200).json(result);
  });
  router.get('/api/conversations/:id', (request, response) => response.json(conversations.detail(session(response).userId, request.params.id)));
  router.patch('/api/conversations/:id', (request, response) => response.json(conversations.setPreference(session(response).userId, request.params.id, parse(updateConversationRequestSchema, request.body).enginePreference)));
  router.get('/api/conversations/:id/messages', (request, response) => {
    const query = parse(messagesQuerySchema, request.query);
    response.json(conversations.messagePage(session(response).userId, request.params.id, query.before, query.limit));
  });
  router.post('/api/conversations/:id/messages', (request, response) => {
    const { created, ...result } = conversations.postMessage(session(response).userId, request.params.id, parse(postMessageRequestSchema, request.body));
    response.status(created ? 202 : 200).json(result);
  });
  router.post('/api/conversations/:id/turns/:turnId/cancel', (request, response) => response.json(conversations.cancel(session(response).userId, request.params.id, request.params.turnId)));
  router.post('/api/conversations/:id/turns/:turnId/retry', (request, response) => {
    const { created, ...result } = conversations.retry(session(response).userId, request.params.id, request.params.turnId);
    response.status(created ? 202 : 200).json(result);
  });
  router.post('/api/conversations/:id/read', (request, response) => response.json(conversations.markRead(session(response).userId, request.params.id, parse(readRequestSchema, request.body).seq)));
  router.post('/api/conversations/:id/plan', (request, response) => {
    const input = parse(generatePlanRequestSchema, request.body ?? {});
    const { created, ...result } = conversations.generatePlan(session(response).userId, request.params.id, input.allowIncomplete);
    response.status(created ? 201 : 200).json(result);
  });
  router.get('/api/plans', (_request, response) => response.json(conversations.listPlans(session(response).userId)));
  router.get('/api/plans/:id', (request, response) => response.json(conversations.getPlan(session(response).userId, request.params.id)));
  return router;
}
