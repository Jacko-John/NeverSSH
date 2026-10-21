/** Exercise remote mutation admission and commit checks through the project's Python launcher. */
import { expect, test } from "bun:test";

test("remote file mutations serialize revision checks and staged upload commits", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/file_commit_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 20000);
