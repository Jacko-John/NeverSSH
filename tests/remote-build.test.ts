/** Run remote build-cache filesystem/lock tests through the project's Python launcher. */
import { expect, test } from "bun:test";

test("remote build cache install, verification, leases, and cleanup", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/remote_build_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 20000);
