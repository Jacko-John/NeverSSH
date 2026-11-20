/** Reproduce helper archive finalization after Darwin's exited-process-group signal error. */
import { expect, test } from "bun:test";

test("helper shutdown finalizes metadata after an exited group's EPERM", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/helper_shutdown_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 10000);
