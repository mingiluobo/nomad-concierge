import { describe, expect, it } from 'vitest';
import { tokenCookieOptions } from '../../src/auth/service.js';

describe('authentication cookie security', () => {
  it.each([
    { production: false, https: false, secure: false },
    { production: false, https: true, secure: false },
    { production: true, https: false, secure: false },
    { production: true, https: true, secure: true },
  ])('sets Secure=$secure for production=$production and HTTPS=$https', ({ production, https, secure }) => {
    expect(tokenCookieOptions(production, https)).toEqual({
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 315360000000, secure,
    });
  });
});
