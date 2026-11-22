/** Reconstruct the same bounded stdout/stderr preview from pushes and requested tails. */
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

const MAX_BYTES = 65536;
const MAX_CHUNKS = 4096;
const encoded = (size: number) => z.string().max(4 * Math.ceil(size / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0);

export const outputEvent = z.object({
  event: z.literal("output"), stream: z.enum(["stdout", "stderr"]),
  base64: encoded(16384), outputBytes: z.number().int().nonnegative(),
});

export const tailEvent = z.object({
  event: z.literal("tail"), outputBytes: z.number().int().nonnegative(), base64: encoded(MAX_BYTES),
  requestId: z.number().int().positive().optional(),
  lengths: z.array(z.number().int().min(-16384).max(16384)).max(MAX_CHUNKS),
  before: z.object({ stdout: encoded(3), stderr: encoded(3) }).optional(),
});

type Stream = "stdout" | "stderr";
export type PreviewChunk = { stream: Stream; text: string };
const streams = ["stdout", "stderr"] as const;

/** Preserve UTF-8 boundaries independently for each stream and publish complete snapshots. */
export class TaskPreview {
  chunks: PreviewChunk[] = [];
  complete = true;
  through = 0;
  private bytes = 0;
  private decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };

  private append(stream: Stream, text: string): void {
    if (!text) return;
    this.chunks.push({ stream, text });
    this.bytes += Buffer.byteLength(text);
    while (this.bytes > MAX_BYTES || this.chunks.length > MAX_CHUNKS) {
      this.bytes -= Buffer.byteLength(this.chunks.shift()!.text);
      this.complete = false;
    }
  }

  output(event: z.infer<typeof outputEvent>): void {
    const bytes = Buffer.from(event.base64, "base64");
    if (bytes.length > 16384 || event.outputBytes !== this.through + bytes.length) throw new Error("Malformed output byte count");
    this.append(event.stream, this.decoders[event.stream].write(bytes));
    this.through = event.outputBytes;
  }

  tail(event: z.infer<typeof tailEvent>): void {
    const bytes = Buffer.from(event.base64, "base64");
    const start = event.outputBytes - bytes.length;
    const skipped = start > this.through;
    if (bytes.length > MAX_BYTES || start < this.through || skipped !== !!event.before || event.lengths.includes(0) ||
        event.lengths.reduce((sum, length) => sum + Math.abs(length), 0) !== bytes.length) {
      throw new Error("Malformed output tail");
    }
    if (event.before) {
      this.chunks = [];
      this.bytes = 0;
      this.complete = false;
      for (const stream of streams) {
        this.decoders[stream] = new StringDecoder("utf8");
        this.decoders[stream].write(Buffer.from(event.before[stream], "base64"));
      }
    }
    // Positive lengths are stdout, negative lengths stderr. Both share the archive order.
    let offset = 0;
    for (const length of event.lengths) {
      const stream = length > 0 ? "stdout" : "stderr";
      const end = offset + Math.abs(length);
      this.append(stream, this.decoders[stream].write(bytes.subarray(offset, end)));
      offset = end;
    }
    this.through = event.outputBytes;
  }

  finish(): void {
    for (const stream of streams) this.append(stream, this.decoders[stream].end());
  }
}
