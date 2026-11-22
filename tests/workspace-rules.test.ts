import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_KNOWN_RULES, WorkspaceRules } from "../src/workspaces/rules";
import type { Instruction } from "../src/workspaces/types";

function instruction(scope: string, content: string): Instruction {
  return { scope, path: scope + "/AGENTS.md", content, sha256: createHash("sha256").update(content).digest("hex") };
}

test("a snapshot retains absent directories, and removals keep the order in which sources were registered", () => {
  const rules = new WorkspaceRules();
  const root = instruction("/project", "Root");
  const child = instruction("/project/src", "Child");
  const scopes = [child.scope, root.scope];
  const empty = rules.observe({ rule_scopes: scopes, instructions: [] }, 1)!;
  const current = rules.observe({ rule_scopes: scopes, instructions: [root, child] }, 2)!;
  rules.displayed(current);
  const removed = rules.observe({ rule_scopes: scopes, instructions: [] }, 3)!;
  scopes.length = 0;
  expect(rules.isCurrent(empty)).toBe(false);
  expect(rules.review(removed, 0)?.removed).toEqual([root, child].map(({ path, scope }) => ({ path, scope })));
});

test("a delayed inspection cannot reintroduce a rule after a newer inspection found its scope empty", () => {
  const rules = new WorkspaceRules();
  const root = instruction("/project", "Root");
  const child = instruction("/project/src", "Source");
  const paths = [root.scope, child.scope];
  const empty = rules.observe({ rule_scopes: paths, instructions: [] }, 2)!;
  expect(rules.observe({ rule_scopes: paths, instructions: [root, child] }, 1)).toBeUndefined();
  expect(rules.isCurrent(empty)).toBe(true);
  // Empty directory bookkeeping may be evicted before the old inspection finishes.
  let order = 3;
  for (let i = 0; i <= MAX_KNOWN_RULES; i++) {
    rules.observe({ rule_scopes: ["/project/empty-" + i], instructions: [] }, order++);
  }
  expect(rules.observe({ rule_scopes: paths, instructions: [] }, 1)).toBeDefined();
  expect(rules.observe({ rule_scopes: paths, instructions: [root] }, 1)).toBeUndefined();
  expect(rules.isCurrent(empty)).toBe(true);
  const fresh = rules.observe({ rule_scopes: paths, instructions: [root, child] }, order)!;
  expect(rules.isCurrent(empty)).toBe(false);
  expect(rules.review(fresh, 0)?.updated).toEqual([root, child]);
});

test("a group receipt confirms its unchanged members when another rule has since been replaced", () => {
  const rules = new WorkspaceRules();
  const root = instruction("/project", "Shared text");
  const child = instruction("/project/src", "Shared text");
  const scopes = [root.scope, child.scope];
  const early = rules.observe({ rule_scopes: scopes, instructions: [root, child] }, 1)!;
  const group = rules.review(early, 0)!;
  rules.displayed(early);
  const revised = instruction(child.scope, "Revised text");
  const current = rules.observe({ rule_scopes: scopes, instructions: [root, revised] }, 2)!;
  const missing = rules.review(current, 0, group.token)!;
  expect(missing.updated).toEqual([revised]);
  expect(missing.changed).toBe(true);
  expect(rules.review(current, rules.confirmedThrough, missing.token)).toBeUndefined();
});

test("a delayed command shows only the still-current part of its guidance", () => {
  const rules = new WorkspaceRules();
  const root = instruction("/project", "Shared text");
  const original = instruction("/project/src", "Shared text");
  const revised = instruction(original.scope, "Revised text");
  const scopes = [root.scope, original.scope];
  const early = rules.observe({ rule_scopes: scopes, instructions: [root, original] }, 1)!;
  const current = rules.observe({ rule_scopes: scopes, instructions: [root, revised] }, 2)!;
  const late = rules.presentation(early, false)!;
  expect(late.updated).toEqual([root]);
  rules.displayed(early);
  expect(rules.presentation(current, false)?.updated).toEqual([revised]);
  expect(rules.review(current, 0, late.token)?.updated).toEqual([revised]);
});

test("receipts from a nested file can still confirm only its root rule after unrelated reviews", () => {
  const rules = new WorkspaceRules();
  const root = instruction("/project", "Root");
  const docs = instruction("/project/docs", "Docs");
  const docsScopes = [root.scope, docs.scope];
  let order = 0;
  const pair = rules.observe({ rule_scopes: docsScopes, instructions: [root, docs] }, ++order)!;
  const both = rules.review(pair, rules.confirmedThrough)!.token;
  rules.displayed(pair);
  for (let i = 0; i <= MAX_KNOWN_RULES; i++) {
    const changing = instruction("/project/changing", String(i));
    const view = rules.observe({ rule_scopes: [root.scope, changing.scope], instructions: [root, changing] }, ++order)!;
    rules.review(view, rules.confirmedThrough);
    rules.displayed(view);
  }
  const rootOnly = rules.observe({ rule_scopes: [root.scope], instructions: [root] }, ++order)!;
  expect(rules.review(rootOnly, rules.confirmedThrough, both)).toBeUndefined();
  expect(rules.review(rootOnly, rules.confirmedThrough)).toBeUndefined();
  expect(rules.review(pair, rules.confirmedThrough)?.updated).toEqual([docs]);
  expect(rules.review(pair, rules.confirmedThrough, both)).toBeUndefined();

  const revised = instruction(docs.scope, "Revised docs");
  const current = rules.observe({ rule_scopes: docsScopes, instructions: [root, revised] }, ++order)!;
  expect(rules.review(current, rules.confirmedThrough, both)?.updated).toEqual([revised]);
});
