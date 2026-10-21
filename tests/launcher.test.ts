/** Verify cached startup and atomic background refresh with local curl and Bun substitutes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../bin/neverssh", import.meta.url));
const OLD_TAG = "v0.2.1";
const NEW_TAG = "v0.2.2";
let root: string;
const pending: Promise<void>[] = [];
const gates: string[] = [];

beforeAll(async () => { root = await mkdtemp("/tmp/neverssh-launcher-test-"); });
afterAll(async () => {
  // Release even a failed test's network gate, then wait for every refresh before deleting files.
  await Promise.all(gates.map((gate) => writeFile(gate, "ready")));
  await Promise.allSettled(pending);
  await rm(root, { recursive: true, force: true });
});

/** Collect one normal launcher stream without waiting for its detached refresh. */
async function output(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let value = "";
  for await (const chunk of stream) value += chunk;
  return value;
}

/** Supply deterministic release responses and track background lifetimes through an inherited fd. */
async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const bin = join(directory, "bin");
  const cacheRoot = join(directory, "cache");
  const cache = join(cacheRoot, "neverssh");
  await mkdir(bin);
  await mkdir(cache, { recursive: true });
  const scripts = {
    curl: `#!/bin/sh
request=download
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -fsSLI) request=head ;;
    -o) shift; out="$1" ;;
  esac
  shift
done
if [ "$request" = head ]; then
  if [ -n "$LAUNCHER_TEST_GATE" ]; then
    while [ ! -f "$LAUNCHER_TEST_GATE" ]; do sleep 0.02; done
  fi
  if [ "$LAUNCHER_TEST_MODE" = offline ]; then exit 7; fi
  printf 'https://github.com/Jacko-John/NeverSSH/releases/tag/%s' "$LAUNCHER_TEST_TAG"
  exit 0
fi
case "$LAUNCHER_TEST_MODE" in
  fail-download) printf 'partial bundle' > "$out"; exit 22 ;;
  interrupt-download) printf 'partial bundle' > "$out"; kill -TERM "$PPID"; exit 143 ;;
esac
printf 'bundle for %s\n' "$LAUNCHER_TEST_TAG" > "$out"
`,
    bun: `#!/bin/sh
printf '%s\n' "$@"
`,
    mv: `#!/bin/sh
for argument do destination="$argument"; done
if [ "$LAUNCHER_TEST_MODE" = interrupt-publish ] && [ "$destination" = "$LAUNCHER_TEST_CACHE/latest" ]; then
  kill -TERM "$PPID"
  exit 143
fi
exec /bin/mv "$@"
`,
  };
  for (const [name, source] of Object.entries(scripts)) {
    const path = join(bin, name);
    await writeFile(path, source);
    await chmod(path, 0o700);
  }

  return {
    cache,
    /** Seed the complete release that a previous successful startup left behind. */
    async seed() {
      await mkdir(join(cache, OLD_TAG));
      await writeFile(join(cache, OLD_TAG, "neverssh.js"), "previous bundle\n");
      await writeFile(join(cache, "latest"), `${OLD_TAG}\n`);
    },
    /** Block mocked resolution until the test has observed a successful cached startup. */
    gate() {
      const path = join(directory, `gate-${gates.length}`);
      gates.push(path);
      return path;
    },
    /** Separate the foreground result from fd 3's EOF after all refresh descendants exit. */
    launch(mode = "success", tag = NEW_TAG, gate = "", args = ["--version"]) {
      const child = spawn(LAUNCHER, args, {
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: cacheRoot,
          LAUNCHER_TEST_MODE: mode, LAUNCHER_TEST_TAG: tag,
          LAUNCHER_TEST_CACHE: cache, LAUNCHER_TEST_GATE: gate,
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const inherited = child.stdio[3] as Readable;
      const done = new Promise<void>((resolve, reject) => {
        inherited.once("end", () => { inherited.destroy(); resolve(); });
        inherited.once("error", reject);
        inherited.resume();
      });
      pending.push(done);
      const exited = new Promise<number>((resolve, reject) => {
        child.once("exit", (code) => resolve(code ?? 1));
        child.once("error", reject);
      });
      const result = Promise.all([exited, output(child.stdout!), output(child.stderr!)]).then(
        ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
      );
      return { result, done };
    },
    /** Cache publication must leave no temporary bundle or pointer files behind. */
    async temporaryFiles() {
      return (await readdir(cache, { recursive: true })).filter((path) =>
        /(?:^|\/)latest\.|neverssh\.js\./.test(path));
    },
  };
}

/** Wait for both ordinary startup and any refresh before checking a settled cache. */
async function drain(launch: ReturnType<Awaited<ReturnType<typeof fixture>>["launch"]>) {
  const result = await launch.result;
  await launch.done;
  return result;
}

test("cached startup returns before network resolution; a successful refresh applies next time", async () => {
  const setup = await fixture();
  await setup.seed();
  const gate = setup.gate();
  const launch = setup.launch("success", NEW_TAG, gate, ["doctor", "host with spaces"]);
  const result = await launch.result;
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, OLD_TAG, "neverssh.js")}\ndoctor\nhost with spaces\n`);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${OLD_TAG}\n`);

  await writeFile(gate, "ready");
  await launch.done;
  const bundle = join(setup.cache, NEW_TAG, "neverssh.js");
  expect(await readFile(bundle, "utf8")).toBe(`bundle for ${NEW_TAG}\n`);
  expect((await stat(bundle)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${NEW_TAG}\n`);
  expect((await drain(setup.launch("offline"))).stdout).toBe(`${bundle}\n--version\n`);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("a failed background download never publishes or executes its partial bytes", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await drain(setup.launch("fail-download"));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, OLD_TAG, "neverssh.js")}\n--version\n`);
  expect(result.stderr).toBe("");
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${OLD_TAG}\n`);
  expect(await Bun.file(join(setup.cache, NEW_TAG, "neverssh.js")).exists()).toBe(false);
  expect((await drain(setup.launch("offline"))).stdout).toBe(result.stdout);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("an unusable recorded tag falls back to another complete cached bundle", async () => {
  const setup = await fixture();
  await setup.seed();
  await writeFile(join(setup.cache, "latest"), `${NEW_TAG}\n`);
  const result = await drain(setup.launch("offline"));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, OLD_TAG, "neverssh.js")}\n--version\n`);
});

test("a cold start downloads and records a usable release", async () => {
  const setup = await fixture();
  const result = await drain(setup.launch());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, NEW_TAG, "neverssh.js")}\n--version\n`);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${NEW_TAG}\n`);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("a failed cold download leaves no cached pointer or partial bundle", async () => {
  const setup = await fixture();
  const result = await drain(setup.launch("fail-download"));
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(await Bun.file(join(setup.cache, "latest")).exists()).toBe(false);
  expect(await Bun.file(join(setup.cache, NEW_TAG, "neverssh.js")).exists()).toBe(false);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("an offline cold start reports that no release is cached", async () => {
  const setup = await fixture();
  const result = await drain(setup.launch("offline"));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no release is cached");
});

test("interrupting background download preserves the usable cache and removes partial bytes", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await drain(setup.launch("interrupt-download"));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, OLD_TAG, "neverssh.js")}\n--version\n`);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${OLD_TAG}\n`);
  expect(await Bun.file(join(setup.cache, NEW_TAG, "neverssh.js")).exists()).toBe(false);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("interrupting background pointer publication preserves its old value and clears staging", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await drain(setup.launch("interrupt-publish"));
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe(`${OLD_TAG}\n`);
  expect(await readFile(join(setup.cache, NEW_TAG, "neverssh.js"), "utf8")).toBe(`bundle for ${NEW_TAG}\n`);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("concurrent refreshes publish whole bundles and pointers without staging leftovers", async () => {
  const setup = await fixture();
  await setup.seed();
  const gate = setup.gate();
  const tags = Array.from({ length: 8 }, (_, index) => index % 2 ? NEW_TAG : "v0.2.3");
  const launches = tags.map((tag) => setup.launch("success", tag, gate));
  const results = await Promise.all(launches.map((launch) => launch.result));
  for (const result of results) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${join(setup.cache, OLD_TAG, "neverssh.js")}\n--version\n`);
  }
  await writeFile(gate, "ready");
  await Promise.all(launches.map((launch) => launch.done));
  const latest = await readFile(join(setup.cache, "latest"), "utf8");
  expect([`${NEW_TAG}\n`, "v0.2.3\n"]).toContain(latest);
  expect(await readFile(join(setup.cache, latest.trim(), "neverssh.js"), "utf8")).toBe(`bundle for ${latest}`);
  expect(await setup.temporaryFiles()).toEqual([]);
});
