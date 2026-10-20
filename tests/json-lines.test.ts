/** Exercise stream framing boundaries shared by worker messages, command output, and stdin. */
import { expect, test } from "bun:test";
import { JsonLines } from "../src/json-lines";

test("delivers complete records in order across arbitrary chunk boundaries", () => {
  const records = new JsonLines(32);
  const received: unknown[] = [];
  const receive = (record: unknown) => received.push(record);

  records.push('{"id":', receive);
  expect(received).toEqual([]);
  records.push('1}\n{"id":2}\n{"id":', receive);
  expect(received).toEqual([{ id: 1 }, { id: 2 }]);
  records.push('3}\n', receive);
  expect(received).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("bounds individual records rather than the total size of a stream chunk", () => {
  const records = new JsonLines(2);
  const received: unknown[] = [];
  records.push("10\n20\n30\n", (record) => received.push(record));
  expect(received).toEqual([10, 20, 30]);
});

test("rejects a complete oversized record before delivering it", () => {
  const records = new JsonLines(2);
  const received: unknown[] = [];
  expect(() => records.push("100\n", (record) => received.push(record))).toThrow("size limit");
  expect(received).toEqual([]);
});

test("rejects an unfinished oversized record even without a newline", () => {
  const records = new JsonLines(2);
  records.push("10", () => {});
  expect(() => records.push("0", () => {})).toThrow("Unterminated");
});

test("delivers earlier valid records before reporting malformed JSON", () => {
  const records = new JsonLines(32);
  const received: unknown[] = [];
  expect(() => records.push('1\ninvalid\n2\n', (record) => received.push(record))).toThrow();
  expect(received).toEqual([1]);
});
