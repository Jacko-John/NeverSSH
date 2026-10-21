/** Verify canonical revisions stay synchronized across remembered remote path aliases. */
import { expect, test } from "bun:test";
import { FileRevisions } from "../src/file-state";

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

test("bounded retention evicts canonical revisions with their aliases", () => {
  const files = new FileRevisions();
  for (let index = 0; index < 513; index++) {
    files.remember("connection", `file-${index}.txt`, { path: `/srv/file-${index}.txt`, sha256: String(index) });
  }
  expect(files.get("connection", "file-0.txt")).toBeUndefined();
  expect(files.get("connection", "/srv/file-0.txt")).toBeUndefined();
  expect(files.get("connection", "file-512.txt")).toEqual({ sha256: "512" });
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
