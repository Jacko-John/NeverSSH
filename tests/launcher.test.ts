/** Exercise release caching and interruption with local curl and Bun substitutes only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../bin/neverssh", import.meta.url));
let root: string;
beforeAll(async () => { root = await mkdtemp("/tmp/neverssh-launcher-test-"); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** Supply deterministic release responses and capture execution without downloading or running code. */
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
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -fsSLI) request=head ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
if [ "$request" = head ]; then
  if [ "$LAUNCHER_TEST_MODE" = offline ]; then exit 7; fi
  printf 'https://github.com/Jacko-John/NeverSSH/releases/tag/%s' "$LAUNCHER_TEST_TAG"
  exit 0
fi
printf 'bundle for %s\n' "$LAUNCHER_TEST_TAG" > "$output"
case "$LAUNCHER_TEST_MODE" in
  fail-download) echo 'mock download failed' >&2; exit 22 ;;
  interrupt-download) kill -TERM "$PPID"; exit 143 ;;
esac
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
    /** Seed a previously usable release, as a successful earlier launcher would. */
    async seed(tag = "v0.2.1") {
      await mkdir(join(cache, tag), { recursive: true });
      await writeFile(join(cache, tag, "neverssh.js"), "previous bundle\n");
      await writeFile(join(cache, "latest"), `${tag}\n`);
    },
    /** Await one isolated shell launcher and its mocked executable output. */
    async run(mode = "success", tag = "v0.2.2", args: string[] = []) {
      const child = Bun.spawn(["sh", LAUNCHER, ...args], {
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: cacheRoot,
          LAUNCHER_TEST_MODE: mode, LAUNCHER_TEST_TAG: tag, LAUNCHER_TEST_CACHE: cache,
        },
        stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
    /** Cache publication must leave no partial bundle or pointer files behind. */
    async temporaryFiles() {
      return (await readdir(cache, { recursive: true })).filter((path) =>
        /(?:^|\/)latest\.|neverssh\.js\./.test(path));
    },
  };
}

test("a failed new release download runs the previous bundle and preserves its pointer", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await setup.run("fail-download", "v0.2.2", ["doctor", "host with spaces"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${join(setup.cache, "v0.2.1", "neverssh.js")}\ndoctor\nhost with spaces\n`);
  expect(result.stderr).toContain("using cached v0.2.1");
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe("v0.2.1\n");
  expect(await Bun.file(join(setup.cache, "v0.2.2", "neverssh.js")).exists()).toBe(false);
  expect(await setup.temporaryFiles()).toEqual([]);

  const offline = await setup.run("offline");
  expect(offline.exitCode).toBe(0);
  expect(offline.stdout).toBe(`${join(setup.cache, "v0.2.1", "neverssh.js")}\n`);
});

test("a failed first download leaves no cached pointer or partial bundle", async () => {
  const setup = await fixture();
  const result = await setup.run("fail-download");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(await Bun.file(join(setup.cache, "latest")).exists()).toBe(false);
  expect(await Bun.file(join(setup.cache, "v0.2.2", "neverssh.js")).exists()).toBe(false);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("a completed download publishes a usable release for later offline startup", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await setup.run();
  const bundle = join(setup.cache, "v0.2.2", "neverssh.js");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`${bundle}\n`);
  expect(await readFile(bundle, "utf8")).toBe("bundle for v0.2.2\n");
  expect((await stat(bundle)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe("v0.2.2\n");
  expect((await setup.run("offline")).stdout).toBe(`${bundle}\n`);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("interrupting a download removes its partial file and preserves the usable cache", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await setup.run("interrupt-download");
  expect(result.exitCode).toBe(143);
  expect(result.stdout).toBe("");
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe("v0.2.1\n");
  expect(await Bun.file(join(setup.cache, "v0.2.2", "neverssh.js")).exists()).toBe(false);
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("interrupting pointer publication keeps the previous pointer intact and clears staging", async () => {
  const setup = await fixture();
  await setup.seed();
  const result = await setup.run("interrupt-publish");
  expect(result.exitCode).toBe(143);
  expect(result.stdout).toBe("");
  expect(await readFile(join(setup.cache, "latest"), "utf8")).toBe("v0.2.1\n");
  expect(await readFile(join(setup.cache, "v0.2.2", "neverssh.js"), "utf8")).toBe("bundle for v0.2.2\n");
  expect(await setup.temporaryFiles()).toEqual([]);
});

test("concurrent launchers publish whole bundle and pointer files without temporary leftovers", async () => {
  const setup = await fixture();
  await setup.seed();
  const tags = Array.from({ length: 8 }, (_, index) => index % 2 ? "v0.2.2" : "v0.2.3");
  const results = await Promise.all(tags.map((tag) => setup.run("success", tag)));
  for (const [index, result] of results.entries()) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${join(setup.cache, tags[index]!, "neverssh.js")}\n`);
  }
  const latest = await readFile(join(setup.cache, "latest"), "utf8");
  expect(["v0.2.2\n", "v0.2.3\n"]).toContain(latest);
  expect(await readFile(join(setup.cache, latest.trim(), "neverssh.js"), "utf8")).toBe(`bundle for ${latest}`);
  expect(await setup.temporaryFiles()).toEqual([]);
});
