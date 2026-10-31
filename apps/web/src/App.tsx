import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { StoreProvider, useStore } from './store/context';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { PlanDetailPage, PlansPage } from './pages/PlansPage';

export function AppRoutes() {
  const { state, retrySession } = useStore();
  const [retrying, setRetrying] = useState(false);
  if (state.booting) return <div className="page-status app-loading" role="status"><span className="spinner" />正在恢复你的咨询空间…</div>;
  if (!state.user && state.pageError) return <div className="page-status app-loading" role="alert"><p>{state.pageError}</p><button data-testid="session-retry" disabled={retrying} onClick={() => { setRetrying(true); void retrySession().finally(() => setRetrying(false)); }}>{retrying ? '正在重试…' : '重试'}</button></div>;
  return <Routes><Route path="/login" element={<LoginPage />} /><Route path="*" element={state.user ? <Layout><Routes><Route path="/" element={<WorkspacePage />} /><Route path="/c/:conversationId" element={<WorkspacePage />} /><Route path="/plans" element={<PlansPage />} /><Route path="/plans/:planId" element={<PlanDetailPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Layout> : <Navigate to="/login" replace />} /></Routes>;
}
export function App() { return <BrowserRouter><StoreProvider><AppRoutes /></StoreProvider></BrowserRouter>; }
