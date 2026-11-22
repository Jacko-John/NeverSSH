/** A connection startup or subsystem probe shared by independently cancellable callers. */
import { abortError } from "../errors";

export class SharedOperation<T> {
  readonly controller = new AbortController();
  readonly promise: Promise<T>;
  private waiters = 0;
  private done = false;

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => { this.done = true; });
  }

  /** Only the last caller leaving unfinished work can cancel the underlying operation. */
  async wait(signal?: AbortSignal): Promise<T> {
    this.waiters++;
    let abort: (() => void) | undefined;
    try {
      if (!signal) return await this.promise;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(abortError(signal));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return await Promise.race([this.promise, cancelled]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      if (--this.waiters === 0 && !this.done) this.controller.abort();
    }
  }
}
