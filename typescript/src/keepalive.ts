/**
 * Sends a KeepAlive after every stretch of send-side quiet. Any outgoing
 * message counts as activity and restarts the countdown.
 */
export class KeepAliveTimer {
  private readonly intervalMs: number;
  private readonly send: () => void;
  private handle: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(intervalMs: number | null | undefined, send: () => void) {
    this.intervalMs = intervalMs ?? 0;
    this.send = send;
  }

  start(): void {
    if (this.intervalMs <= 0 || this.running) return;
    this.running = true;
    this.schedule();
  }

  notifyActivity(): void {
    if (!this.running) return;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private schedule(): void {
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.handle = setTimeout(() => {
      this.send();
      if (this.running) this.schedule();
    }, this.intervalMs);
    // Do not keep the Node process alive just for keepalives.
    const handle = this.handle as { unref?: () => void };
    handle.unref?.();
  }
}
