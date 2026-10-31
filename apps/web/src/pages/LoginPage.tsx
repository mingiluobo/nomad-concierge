import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { TID, loginRequestSchema } from '@nomad/shared';
import { api } from '../api/client';
import { useStore } from '../store/context';

export function LoginPage() {
  const { state, dispatch, handleError, scope, isCurrent } = useStore();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (state.user) return <Navigate to="/" replace />;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ username });
    if (!parsed.success) { setError('用户名请填写 2～32 个字符。'); return; }
    const token = scope(); setBusy(true); setError('');
    try { const result = await api.login(parsed.data.username); if (isCurrent(token)) { dispatch({ type: 'user', user: result.user, limits: result.limits }); navigate('/', { replace: true }); } }
    catch (caught) { if (isCurrent(token)) setError(handleError(caught)); }
    finally { if (isCurrent(token)) setBusy(false); }
  }
  return <main className="login-page"><div className="login-art"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="login-coordinate">A CLEARER PATH TO YOUR NEXT CHAPTER</span><h1>下一程，<br />从容出发。</h1><p>把模糊的想法，整理成清晰的行动计划。</p></div><section className="login-card"><div className="brand"><span className="brand-mark">N</span><span>Nomad<span className="brand-sub">CONCIERGE</span></span></div><h2>欢迎来到你的咨询空间</h2><p className="muted">用一个用户名，开始或继续你的计划。</p><form onSubmit={event => void submit(event)}><label htmlFor="username">用户名</label><input id="username" data-testid={TID.loginUsername} value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus aria-describedby="login-error" disabled={busy} /><p id="login-error" data-testid={TID.loginError} role={error || state.pageError ? 'alert' : undefined} className="error-text">{error || state.pageError}</p><button className="primary" data-testid={TID.loginSubmit} disabled={busy}>{busy ? '正在进入…' : '进入咨询空间 →'}</button></form><p className="login-note">演示用身份识别，不是安全认证；输入同一用户名即可恢复之前的记录。</p></section></main>;
}
