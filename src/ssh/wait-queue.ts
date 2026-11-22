import { abortError, checkAbort, ToolError } from "../errors";

/** All admission stages on one connection spend the same 64 waiting slots. */
export class WaitBudget {
  private used = 0;

  reserve(): void {
    if (this.used >= 64) throw new ToolError("CONNECTION_BUSY", "Too many queued operations");
    this.used++;
  }

  release(): void { this.used--; }
}

/** FIFO admission for one resource. Cancellation removes just its own waiter. */
export class WaitQueue {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly budget: WaitBudget) {}

  wait(signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    this.budget.reserve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.waiters.delete(wake)) return;
        this.budget.release();
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(abortError(signal!));
      const timer = setTimeout(() => finish(new ToolError("CONNECTION_BUSY", "Timed out waiting for an operation slot")), 30000);
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  wakeOne(): boolean {
    const first = this.waiters.values().next().value;
    first?.();
    return first !== undefined;
  }

  wakeAll(): void {
    for (const wake of this.waiters) wake();
  }
}
