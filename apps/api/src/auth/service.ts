import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { UserDto } from '@nomad/shared';
import type { RequestHandler, CookieOptions } from 'express';
import type { AppConfig } from '../config.js';
import type { ConnectionRegistry } from '../composition.js';
import type { AppDatabase } from '../db/database.js';
import { UsersRepository } from '../repositories/users.js';
import { AuthTokensRepository } from '../repositories/authTokens.js';
import { AppError } from '../http/errors.js';

export interface AuthSession { user: UserDto; userId: string; tokenHash: string }
export class AuthenticationService {
  private readonly users: UsersRepository;
  private readonly tokens: AuthTokensRepository;
  constructor(private readonly db: AppDatabase, private readonly registry: ConnectionRegistry, private readonly config: Pick<AppConfig, 'tokensPerUser'>) {
    this.users = new UsersRepository(db); this.tokens = new AuthTokensRepository(db);
  }
  login(username: string): { user: UserDto; token: string } {
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      let user = this.users.byKey(username.toLowerCase());
      if (!user) { const id = randomUUID(); this.users.insert(id, username, now); user = { id, username }; }
      this.tokens.insert(tokenHash, user.id, now);
      const all = this.tokens.oldest(user.id);
      const removed = all.slice(0, Math.max(0, all.length - this.config.tokensPerUser));
      for (const item of removed) this.tokens.remove(item.token_hash);
      return { user: { ...user }, removed: removed.map(item => item.token_hash) };
    });
    if (result.removed.length) this.registry.closeByTokenHash(result.removed, 4401);
    return { user: result.user, token };
  }
  authenticateToken(rawToken: unknown): AuthSession | null {
    if (typeof rawToken !== 'string' || !/^[a-f0-9]{64}$/.test(rawToken)) return null;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const token = this.tokens.get(tokenHash);
    const user = token ? this.users.get(token.user_id) : undefined;
    return user ? { user: { ...user }, userId: user.id, tokenHash } : null;
  }
  logout(session: AuthSession): void {
    this.db.transaction(() => this.tokens.remove(session.tokenHash));
    this.registry.closeByTokenHash([session.tokenHash], 4401);
  }
  readonly requireSession: RequestHandler = (request, response, next) => {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const session = this.authenticateToken(cookies?.nc_token);
    if (!session) { next(new AppError('UNAUTHENTICATED', 401, '请先登录。')); return; }
    response.locals.session = session;
    next();
  };
}
export function tokenCookieOptions(production: boolean, secureRequest: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 315360000000, secure: production && secureRequest };
}
