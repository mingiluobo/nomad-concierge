import type { SocketLike } from '../realtime/socket';
export class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null; onmessage: SocketLike['onmessage'] = null; onclose: SocketLike['onclose'] = null; onerror: SocketLike['onerror'] = null;
  sent: string[] = []; closed = false;
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; this.onclose?.(new CloseEvent('close', { code: 1000 })); }
  open() { this.onopen?.(new Event('open')); }
  frame(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })); }
  disconnect(code = 1006) { this.onclose?.(new CloseEvent('close', { code })); }
}
