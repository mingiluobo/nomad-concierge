export function attention(unread: number, visible: boolean, focused: boolean) {
  const notify = unread > 0 && (!visible || !focused);
  return { title: notify ? `(${unread}) Nomad Concierge` : 'Nomad Concierge', notify };
}
export function favicon(notify: boolean): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#174f49"/><path d="M9 23V9l14 14V9" fill="none" stroke="white" stroke-width="3"/>${notify ? '<circle cx="25" cy="7" r="6" fill="#e15642" stroke="white" stroke-width="2"/>' : ''}</svg>`)}`;
}
