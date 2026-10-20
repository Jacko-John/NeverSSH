/** Model-readable failures and abortable waits shared by connection lifecycle operations. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
  }
}

/** Reject cancelled work before opening a remote request or committing a local transfer. */
export function checkAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof ToolError) throw signal.reason;
  throw new ToolError("OPERATION_CANCELLED", "Operation cancelled");
}

/** Normalize unknown failures so text and structured results share one code and message. */
function failure(error: unknown): ToolError {
  return error instanceof ToolError
    ? error
    : new ToolError("OPERATION_FAILED", error instanceof Error ? error.message : String(error));
}

/** Preserve actionable codes without exposing stacks or full SSH configuration. */
export function errorResult(error: unknown): Record<string, unknown> {
  const value = failure(error);
  return { error: { code: value.code, message: value.message, details: value.details } };
}

/** Give every tool the same model-readable error shape. */
export function errorText(error: unknown): string {
  const value = failure(error);
  return `Error: ${value.code}\n${value.message}`;
}

/** Bound a caller's wait without abandoning rejection handlers on shared work. */
export async function bounded<T>(promise: Promise<T>, timeout: number, code: string, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(code, message)), timeout);
    abort = () => {
      const reason = signal?.reason instanceof ToolError
        ? signal.reason
        : new ToolError("OPERATION_CANCELLED", "Operation cancelled");
      reject(reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
