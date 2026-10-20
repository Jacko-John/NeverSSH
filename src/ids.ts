/** Allocates short handles without reusing an earlier handle in this registry's lifetime. */
import { randomBytes } from "node:crypto";

export class ShortIds {
  private readonly issued = new Set<string>();

  /** Reserve an eight-character lowercase hexadecimal ID, retrying random collisions. */
  next(): string {
    let id: string;
    do {
      id = randomBytes(4).toString("hex");
    } while (this.issued.has(id));
    this.issued.add(id);
    return id;
  }
}
