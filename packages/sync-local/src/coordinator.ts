export type SyncTrigger = 'local-write' | 'foreground' | 'manual';
export interface SyncCoordinatorOptions {
  eligible(): Promise<boolean>;
  cycle(interactive: boolean, signal: AbortSignal): Promise<void>;
  /** Transport scheduling only; immutable commits are never compacted. */
  debounceMs?: number;
  coalesceMs?: number;
}
/** One foreground scheduler per bank. No polling, persisted visual state or automatic login. */
export class SyncCoordinator {
  private active = false;
  private disposed = false;
  private cancelled = false;
  private pending = false;
  private due = 0;
  private lastStarted = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private waiters: { resolve(): void; reject(error: unknown): void }[] = [];
  private listeners = new Set<() => void>();
  running = false;
  lastCompletedAt?: string;
  error?: string;
  constructor(private readonly options: SyncCoordinatorOptions) {}
  get foreground() {
    return this.active && !this.disposed;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot affect transport or local commits. */
      }
    }
  }
  setForeground(active: boolean) {
    this.active = active;
    if (!active) {
      this.clearTimer();
      this.abort?.abort();
    } else this.request('foreground');
  }
  request(trigger: 'manual'): Promise<void>;
  request(trigger: 'local-write' | 'foreground'): void;
  request(trigger: SyncTrigger): Promise<void> | void {
    if (trigger === 'manual' && !this.foreground)
      return Promise.reject(new Error('foreground_inactive'));
    if (this.disposed)
      return trigger === 'manual'
        ? Promise.reject(new Error('sync_disposed'))
        : undefined;
    // Focus storms during a pass are already covered. Writes/manual requests need another pass.
    if (trigger === 'foreground' && this.running && !this.abort?.signal.aborted)
      return;
    const now = Date.now();
    if (
      trigger === 'foreground' &&
      !this.pending &&
      !this.abort?.signal.aborted &&
      this.error !== 'foreground_inactive' &&
      now - this.lastStarted < (this.options.coalesceMs ?? 2000)
    )
      return;
    const alreadyPending = this.pending;
    this.pending = true;
    if (trigger === 'manual') {
      this.due = now;
      const result = new Promise<void>((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
      this.schedule();
      return result;
    }
    if (!this.waiters.length) {
      if (trigger === 'local-write')
        this.due = now + (this.options.debounceMs ?? 2000);
      else if (!alreadyPending)
        this.due = Math.max(
          now,
          this.lastStarted + (this.options.coalesceMs ?? 2000),
        );
    }
    this.changed();
    this.schedule();
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule() {
    this.clearTimer();
    if (!this.pending || this.running || this.disposed || !this.active) return;
    this.timer = setTimeout(
      () => {
        void this.pass();
      },
      Math.max(0, this.due - Date.now()),
    );
  }
  private async pass() {
    if (this.running || !this.foreground || !this.pending) return;
    this.clearTimer();
    this.cancelled = false;
    this.running = true; // Reserve before any asynchronous eligibility/session work.
    this.pending = false;
    const waiters = this.waiters;
    this.waiters = [];
    this.abort = new AbortController();
    this.changed();
    try {
      if (!(await this.options.eligible())) {
        if (waiters.length) throw new Error('sync_disabled_or_paused');
        return;
      }
      if (!this.foreground || this.abort.signal.aborted)
        throw new Error('foreground_inactive');
      this.lastStarted = Date.now();
      await this.options.cycle(waiters.length > 0, this.abort.signal);
      if (this.abort.signal.aborted) throw new Error('foreground_inactive');
      this.lastCompletedAt = new Date().toISOString();
      this.error = undefined;
      waiters.forEach((w) => w.resolve());
    } catch (error) {
      this.error = this.abort.signal.aborted
        ? 'foreground_inactive'
        : error instanceof Error
          ? error.message
          : 'temporary_failure';
      if (
        this.abort.signal.aborted &&
        waiters.length &&
        !this.disposed &&
        !this.cancelled
      ) {
        // System-browser login temporarily blurs the app. Preserve the explicit manual request
        // and its waiters for resume; the next pass can use the newly validated session.
        this.pending = true;
        this.due = Date.now();
        this.waiters.unshift(...waiters);
      } else waiters.forEach((w) => w.reject(error));
    } finally {
      this.abort = undefined;
      this.running = false;
      // A write/manual request arriving during any await belongs to the next pass.
      if (this.pending && !this.waiters.length)
        this.due = Math.max(
          this.due,
          this.lastStarted + (this.options.coalesceMs ?? 2000),
        );
      this.changed();
      this.schedule();
    }
  }
  cancel() {
    this.cancelled = true;
    this.pending = false;
    this.clearTimer();
    this.abort?.abort();
    this.waiters.forEach((w) => w.reject(new Error('sync_paused')));
    this.waiters = [];
  }
  /** Recovery excludes even the tail of an aborted pass, including its profile save. */
  async cancelAndWait() {
    this.cancel();
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (!this.running) { unsubscribe(); resolve(); }
      });
    });
  }
  dispose() {
    this.disposed = true;
    this.active = false;
    this.clearTimer();
    this.abort?.abort();
    this.waiters.forEach((w) => w.reject(new Error('sync_disposed')));
    this.waiters = [];
    this.listeners.clear();
  }
}
const banks = new WeakMap<object, SyncCoordinator>();
export function bankSyncCoordinator(
  bank: object,
  options: SyncCoordinatorOptions,
): SyncCoordinator {
  let coordinator = banks.get(bank);
  if (!coordinator) {
    coordinator = new SyncCoordinator(options);
    banks.set(bank, coordinator);
  }
  return coordinator;
}
