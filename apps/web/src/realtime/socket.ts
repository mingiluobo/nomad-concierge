import { serverMessageSchema } from '@nomad/shared';
import type { BusinessEvent, RuntimeLimits, UserDto } from '@nomad/shared';
import { ApiError } from '../api/client';
import type { Action, AppState } from '../store/reducer';

export interface SocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}
interface Options {
  getState(): AppState;
  dispatch(action: Action): void;
  snapshot(isCurrent: () => boolean): Promise<void>;
  me(): Promise<{ user: UserDto; limits?: RuntimeLimits }>;
  createSocket(): SocketLike;
}
export class RealtimeClient {
  private socket?: SocketLike;
  private stopped = false;
  private connectionId = 0;
  private initialized = false;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private syncTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: Options) {}
  start(): void { this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true;
    this.connectionId += 1;
    clearTimeout(this.timer);
    clearTimeout(this.syncTimer);
    this.socket?.close();
  }
  private connect(): void {
    if (this.stopped) return;
    const connectionId = ++this.connectionId;
    const socket = this.options.createSocket();
    this.socket = socket;
    let ready = false;
    let events: BusinessEvent[] = [];
    const current = () => !this.stopped && connectionId === this.connectionId;
    socket.onopen = () => {
      if (current()) socket.send(JSON.stringify({ type: 'resume', lastEventId: this.initialized ? this.options.getState().lastEventId : null }));
    };
    socket.onmessage = event => {
      if (!current()) return;
      let raw: unknown;
      try { raw = JSON.parse(event.data); } catch { return; }
      const parsed = serverMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'resync_required') {
        this.initialized = false;
        ready = false;
        events = [];
        this.options.dispatch({ type: 'reset' });
      } else if (message.type === 'event') {
        if (ready) this.options.dispatch({ type: 'event', event: message });
        else events.push(message);
      } else {
        if (message.userId !== this.options.getState().user?.id) {
          events = [];
          this.options.dispatch({ type: 'reset' });
          const recoveryId = ++this.connectionId;
          socket.close();
          const generation = this.options.getState().generation;
          const recoveryCurrent = () => !this.stopped && recoveryId === this.connectionId && generation === this.options.getState().generation;
          const refreshIdentity = async () => {
            try {
              const { user, limits } = await this.options.me();
              if (!recoveryCurrent()) return;
              this.stop();
              this.options.dispatch({ type: 'user', user, limits });
            } catch (error) {
              if (!recoveryCurrent()) return;
              if (error instanceof ApiError && error.status === 401) { this.stop(); this.options.dispatch({ type: 'user', user: null }); }
              else {
                this.options.dispatch({ type: 'connection', connection: 'sync_failed' });
                this.syncTimer = setTimeout(() => { if (recoveryCurrent()) void refreshIdentity(); }, 1000);
              }
            }
          };
          void refreshIdentity();
          return;
        }
        ready = true;
        this.retry = 0;
        for (const buffered of events) this.options.dispatch({ type: 'event', event: buffered });
        events = [];
        const generation = this.options.getState().generation;
        const stillCurrent = () => current() && this.options.getState().generation === generation;
        const sync = async () => {
          if (!stillCurrent()) return;
          this.options.dispatch({ type: 'connection', connection: 'syncing' });
          try {
            await this.options.snapshot(stillCurrent);
            if (!stillCurrent()) return;
            this.initialized = true;
            this.options.dispatch({ type: 'cursor', id: message.latestEventId });
            this.options.dispatch({ type: 'connection', connection: 'live' });
          } catch (error) {
            if (!stillCurrent()) return;
            if (error instanceof ApiError && error.status === 401) { this.stop(); this.options.dispatch({ type: 'user', user: null }); return; }
            this.options.dispatch({ type: 'connection', connection: 'sync_failed' });
            this.syncTimer = setTimeout(() => { void sync(); }, 1000);
          }
        };
        void sync();
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = event => {
      if (!current()) return;
      this.connectionId += 1;
      clearTimeout(this.syncTimer);
      if (event.code === 4401) { this.stop(); this.options.dispatch({ type: 'user', user: null }); return; }
      if (!this.initialized) this.options.dispatch({ type: 'reset' });
      this.options.dispatch({ type: 'connection', connection: 'reconnecting' });
      const closedId = this.connectionId;
      const generation = this.options.getState().generation;
      void this.options.me().then(({ user, limits }) => {
        if (this.stopped || closedId !== this.connectionId || generation !== this.options.getState().generation) return;
        if (user.id !== this.options.getState().user?.id) { this.stop(); this.options.dispatch({ type: 'user', user, limits }); return; }
        this.options.dispatch({ type: 'limits', limits });
        this.schedule();
      }).catch(error => {
        if (this.stopped || closedId !== this.connectionId || generation !== this.options.getState().generation) return;
        if (error instanceof ApiError && error.status === 401) { this.stop(); this.options.dispatch({ type: 'user', user: null }); }
        else this.schedule();
      });
    };
  }
  private schedule(): void {
    const delays = [1000, 2000, 5000, 10000];
    const delay = delays[Math.min(this.retry++, delays.length - 1)] ?? 10000;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
