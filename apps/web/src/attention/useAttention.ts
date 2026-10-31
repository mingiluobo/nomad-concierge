import { useEffect } from 'react';
import { api } from '../api/client';
import { useStore } from '../store/context';
import { unreadCount } from '../store/reducer';
import { attention, favicon } from './attention';

export function useAttention(conversationId?: string) {
  const { state, dispatch, scope, isCurrent, handleError } = useStore();
  const count = unreadCount(state);
  const assistantSeq = conversationId ? state.conversationSummaries[conversationId]?.lastAssistantSeq ?? 0 : 0;
  const readSeq = conversationId ? state.readStates[conversationId] ?? 0 : 0;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const visible = document.visibilityState === 'visible';
      const focused = document.hasFocus();
      const value = attention(count, visible, focused);
      document.title = value.title;
      let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
      icon.href = favicon(value.notify);
      clearTimeout(timer);
      if (!conversationId || !visible || !focused || assistantSeq <= readSeq) return;
      const token = scope(true);
      timer = setTimeout(() => {
        if (!isCurrent(token) || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        void api.read(conversationId, assistantSeq).then(result => dispatch({ type: 'read', conversationId, seq: result.lastReadSeq, scope: token })).catch(error => { if (isCurrent(token)) handleError(error); });
      }, 300);
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      clearTimeout(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('blur', update);
      document.title = 'Nomad Concierge';
      const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (icon) icon.href = favicon(false);
    };
  }, [count, conversationId, assistantSeq, readSeq, dispatch, scope, isCurrent, handleError]);
}
