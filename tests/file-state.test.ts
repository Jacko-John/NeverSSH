/** Verify canonical revisions stay synchronized across remembered remote path aliases. */
import { expect, test } from "bun:test";
import { FileRevisions } from "../src/files/revisions";

test("relative and absolute aliases follow the latest canonical revision", () => {
  const files = new FileRevisions();
  files.remember("connection", "src/file.txt", { path: "/srv/src/file.txt", sha256: "first" });
  files.remember("connection", "/srv/src/file.txt", { path: "/srv/src/file.txt", sha256: "second" });
  expect(files.get("connection", "src/file.txt")).toEqual({ sha256: "second" });

  files.remember("connection", "./src/../src/file.txt", { path: "/srv/src/file.txt", sha256: "third" });
  expect(files.get("connection", "/srv/src/file.txt")).toEqual({ sha256: "third" });
  expect(files.get("connection", "src/file.txt")).toEqual({ sha256: "third" });
});

test("rereading a repointed symlink moves only that alias to its new canonical file", () => {
  const files = new FileRevisions();
  files.remember("connection", "link.txt", { path: "/srv/first.txt", sha256: "first" });
  files.remember("connection", "another-link.txt", { path: "/srv/first.txt", sha256: "first-updated" });
  files.remember("connection", "link.txt", { path: "/srv/second.txt", sha256: "second" });
  files.remember("connection", "/srv/second.txt", { path: "/srv/second.txt", sha256: "second-updated" });

  expect(files.get("connection", "link.txt")).toEqual({ sha256: "second-updated" });
  expect(files.get("connection", "/srv/first.txt")).toEqual({ sha256: "first-updated" });
  expect(files.get("connection", "another-link.txt")).toEqual({ sha256: "first-updated" });
});

test("the same remote spelling remains isolated between connections", () => {
  const files = new FileRevisions();
  files.remember("first", "file.txt", { path: "/srv/file.txt", sha256: "first" });
  files.remember("second", "file.txt", { path: "/srv/file.txt", sha256: "second" });
  expect(files.get("first", "/srv/file.txt")).toEqual({ sha256: "first" });
  expect(files.get("second", "file.txt")).toEqual({ sha256: "second" });
});

test("overlapping and out-of-order pages cover only the observed revision", () => {
  const files = new FileRevisions();
  const page = (sha256: string, startLine: number, endLine: number) =>
    files.remember("id", "alias", { path: "/file", sha256, startLine, endLine, totalLines: 8 });
  page("initial", 5, 8);
  page("initial", 2, 6);
  expect(files.get("id", "alias")).toBeUndefined();
  page("initial", 1, 2);
  expect(files.get("id", "/file")).toEqual({ sha256: "initial" });
  page("new", 8, 8);
  expect(files.get("id", "/file")).toBeUndefined();
  page("new", 1, 7);
  expect(files.get("id", "/file")).toEqual({ sha256: "new" });
});

test("partial coverage keeps rendered PDF pages, source lines, and different totals separate", () => {
  const files = new FileRevisions();
  const part = (kind: string, startLine: number, endLine: number, totalLines: number) =>
    files.remember("id", kind === "document" ? "/manual.pdf" : "/asset", {
      path: "/asset", sha256: "same", kind, startLine, endLine, totalLines,
    });
  part("text", 1, 10, 20);
  part("document", 11, 20, 20);
  expect(files.get("id", "/asset")).toBeUndefined();
  part("document", 1, 10, 30);
  expect(files.get("id", "/asset")).toBeUndefined();
  part("document", 11, 30, 30);
  expect(files.get("id", "/asset")).toEqual({ sha256: "same" });
});

test("concurrent reads of identical bytes can finish their pages in reverse order", () => {
  const files = new FileRevisions();
  const first = files.nextObservation();
  const second = files.nextObservation();
  const snapshot = { path: "/asset", sha256: "same", totalLines: 5 };
  files.remember("id", "/asset", { ...snapshot, startLine: 3, endLine: 5 }, second);
  files.remember("id", "/asset", { ...snapshot, startLine: 1, endLine: 2 }, first);
  expect(files.get("id", "/asset")).toEqual({ sha256: "same" });
});

test("a sparse page history stays conservative and a continuous read can complete it", () => {
  const files = new FileRevisions();
  const page = (startLine: number, endLine: number) =>
    files.remember("id", "/file", { path: "/file", sha256: "same", startLine, endLine, totalLines: 100 });
  for (let odd = 1; odd < 100; odd += 2) page(odd, odd);
  for (let even = 2; even <= 100; even += 2) page(even, even);
  expect(files.get("id", "/file")).toBeUndefined();
  page(63, 100);
  expect(files.get("id", "/file")).toEqual({ sha256: "same" });
});

test("late shell views cannot roll back newer canonical or alias observations", () => {
  const files = new FileRevisions();
  const order = files.nextObservation();
  files.remember("id", "/alias", { path: "/new", sha256: "new" });
  files.remember("id", "/alias", { path: "/old", sha256: "old" }, order);
  expect(files.get("id", "/alias")).toEqual({ sha256: "new" });
  files.remember("id", "/another-alias", { path: "/new", sha256: "old" }, order);
  expect(files.get("id", "/new")).toEqual({ sha256: "new" });
  const sameVersion = files.nextObservation();
  files.remember("id", "/new", { path: "/new", sha256: "same bytes", startLine: 1, endLine: 2, totalLines: 10 });
  expect(files.get("id", "/new")).toBeUndefined();
  files.remember("id", "/new", { path: "/new", sha256: "same bytes" }, sameVersion);
  expect(files.get("id", "/new")).toEqual({ sha256: "same bytes" });
});

test("bounded retention evicts canonical revisions with their aliases", () => {
  const files = new FileRevisions();
  const oldView = files.nextObservation();
  for (let index = 0; index < 513; index++) {
    files.remember("connection", `file-${index}.txt`, { path: `/srv/file-${index}.txt`, sha256: String(index) });
  }
  expect(files.get("connection", "file-0.txt")).toBeUndefined();
  expect(files.get("connection", "/srv/file-0.txt")).toBeUndefined();
  expect(files.get("connection", "file-512.txt")).toEqual({ sha256: "512" });
  files.remember("connection", "file-0.txt", { path: "/srv/file-0.txt", sha256: "stale" }, oldView);
  expect(files.get("connection", "/srv/file-0.txt")).toBeUndefined();
});

test("many aliases share a revision without exceeding the retained entry budget", () => {
  const files = new FileRevisions();
  for (let index = 0; index < 1100; index++) {
    files.remember("connection", `alias-${index}.txt`, { path: "/srv/file.txt", sha256: String(index) });
  }
  expect(files.get("connection", "alias-0.txt")).toBeUndefined();
  expect(files.get("connection", "alias-1099.txt")).toEqual({ sha256: "1099" });
  expect(files.get("connection", "/srv/file.txt")).toEqual({ sha256: "1099" });
});
