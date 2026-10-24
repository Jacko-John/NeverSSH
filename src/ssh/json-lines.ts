/** Decode bounded JSON lines while preserving record order across arbitrary stream chunks. */
export class JsonLines {
  private buffered = "";

  constructor(private readonly maxRecordLength: number) {}

  /** Deliver complete records immediately; reject oversized complete or unfinished records. */
  push(chunk: string, receive: (record: unknown) => void): void {
    this.buffered += chunk;

    let newline: number;
    while ((newline = this.buffered.indexOf("\n")) >= 0) {
      if (newline > this.maxRecordLength) {
        throw new Error("JSON protocol record exceeds its size limit");
      }

      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      receive(JSON.parse(line));
    }

    if (this.buffered.length > this.maxRecordLength) {
      throw new Error("Unterminated JSON protocol record exceeds its size limit");
    }
  }
}
