/** Exercise the Bash helper's output, exit notification, and archive cleanup. */
import { expect, test } from "bun:test";

test("helper wakes on exit, drains output, and finalizes its archive", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/helper_shutdown_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 10000);
