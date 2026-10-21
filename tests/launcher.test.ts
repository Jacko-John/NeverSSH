/** The release launcher: cached starts never wait for the network, and refresh happens in the background. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";

const LAUNCHER = resolve("bin/neverssh");
const RELEASE = "v9.9.9";

/** Stand-in for curl: answers the launcher's two requests, and fails when the tag is unset. */
const CURL = `#!/bin/sh
mode=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2; continue ;;
    */releases/latest) mode=latest ;;
    */releases/download/*) mode=asset ;;
  esac
  shift
done
case "$mode" in
  latest)
    [ -n "\${STUB_TAG:-}" ] || exit 22
    sleep "\${STUB_TAG_DELAY:-0}"
    printf '%s\\n' "https://github.com/Jacko-John/NeverSSH/releases/tag/$STUB_TAG" ;;
  asset)
    [ -n "\${STUB_BUNDLE:-}" ] || exit 22
    cp "$STUB_BUNDLE" "$out" ;;
  *) exit 22 ;;
esac
`;

let root = "";
let stub = "";
let bundle = "";

/** Lay down a cache directory holding one complete release, as an earlier launcher run would. */
async function cached(cache: string, tag: string): Promise<void> {
  await mkdir(join(cache, "neverssh", tag), { recursive: true });
  await writeFile(join(cache, "neverssh", tag, "neverssh.js"), await readFile(bundle));
  await writeFile(join(cache, "neverssh", "latest"), `${tag}\n`);
}

/** Run the launcher against the stub network, returning its exit code and streams. */
async function launch(cache: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([LAUNCHER, "--version"], {
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, XDG_CACHE_HOME: cache, ...env } as Record<string, string>,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Wait for the detached refresh, which outlives the process that started it. */
async function waitForRecordedRelease(cache: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const recorded = await readFile(join(cache, "neverssh", "latest"), "utf8").catch(() => "");
    const downloaded = await stat(join(cache, "neverssh", RELEASE, "neverssh.js")).then(() => true).catch(() => false);
    if (recorded.trim() === RELEASE && downloaded) return;
    await delay(25);
  }
  throw new Error(`The background refresh never recorded ${RELEASE}`);
}

beforeAll(async () => {
  root = await mkdtemp("/tmp/neverssh-launcher-test-");
  stub = join(root, "bin");
  await mkdir(stub);
  await writeFile(join(stub, "curl"), CURL);
  await chmod(join(stub, "curl"), 0o700);
  bundle = join(root, "bundle.js");
  await writeFile(bundle, 'console.log("stub bundle");\n');
}, 10000);

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("release launcher", () => {
  test("starts a cached release without waiting for the network", async () => {
    const cache = join(root, "warm");
    await cached(cache, "v0.1.0");
    // The tag resolves only after a delay, so a start that waited for the network would show it.
    const started = Date.now();
    const result = await launch(cache, { STUB_TAG: RELEASE, STUB_BUNDLE: bundle, STUB_TAG_DELAY: "3" });
    expect(result.stdout).toBe("stub bundle");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 20000);

  test("keeps starting from the cache while the network is down", async () => {
    const cache = join(root, "offline");
    await cached(cache, "v0.1.0");
    const result = await launch(cache);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("stub bundle");
  }, 20000);

  test("refreshes the cache in the background and records the new release", async () => {
    const cache = join(root, "refresh");
    await cached(cache, "v0.1.0");
    const result = await launch(cache, { STUB_TAG: RELEASE, STUB_BUNDLE: bundle });
    expect(result.stdout).toBe("stub bundle");
    await waitForRecordedRelease(cache);
  }, 20000);

  test("falls back to a complete cached release when the recorded tag has no bundle", async () => {
    const cache = join(root, "partial");
    await cached(cache, "v0.1.0");
    await writeFile(join(cache, "neverssh", "latest"), `${RELEASE}\n`);
    const result = await launch(cache);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("stub bundle");
  }, 20000);

  test("downloads and records the release on a cold start", async () => {
    const cache = join(root, "cold");
    const result = await launch(cache, { STUB_TAG: RELEASE, STUB_BUNDLE: bundle });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("stub bundle");
    expect((await readFile(join(cache, "neverssh", "latest"), "utf8")).trim()).toBe(RELEASE);
  }, 20000);

  test("reports an unusable start when nothing is cached and the network is down", async () => {
    const cache = join(root, "empty");
    const result = await launch(cache);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no release is cached");
  }, 20000);
});
