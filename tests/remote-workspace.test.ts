/** Exercise remote workspace boundaries and discovery through the supported Python launcher. */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Runtime } from "../src/runtime";
import { SshFixture } from "./fixture";

test("remote workspace guidance, skills, bounded discovery, and Git inspection", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/remote_workspace_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 20000);

test("small file budgets admit bounded Git previews and reject oversized rule sets without losing the connection", async () => {
  const fixture = new SshFixture();
  let runtime: Runtime | undefined;
  try {
    await fixture.start();
    const git = Bun.spawn(["git", "init", "--quiet", fixture.workspace], { stdout: "pipe", stderr: "pipe" });
    const gitError = await new Response(git.stderr).text();
    expect(await git.exited, gitError).toBe(0);
    await writeFile(join(fixture.workspace, "AGENTS.md"), "\x01".repeat(1024));
    for (let index = 0; index < 100; index++) {
      const skillDirectory = join(fixture.workspace, ".agents/skills", `skill-${index}`);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: skill-${index}\ndescription: ${"a".repeat(650)}\n---\n`);
    }
    for (let index = 0; index < 300; index++) {
      await writeFile(join(fixture.workspace, `change-${String(index).padStart(3, "0")}-${"x".repeat(220)}`), "change");
    }
    runtime = new Runtime({ ...fixture.config, maxFileBytes: 1024 });
    const connection = await runtime.ssh.connect({ host: "fixture" });
    const id = String(connection.connection_id);
    const withoutSkills = await runtime.ssh.run(id, "workspace_open", { path: fixture.workspace, skillDirectories: [] });
    expect(withoutSkills.instructions).toHaveLength(1);
    const opened = await runtime.ssh.run(id, "workspace_open", { path: fixture.workspace });
    expect(opened.skill_files).toHaveLength(100);
    expect(opened.git).toMatchObject({ omitted: expect.any(Number) });

    let directory = fixture.workspace;
    for (let index = 0; index < 25; index++) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "AGENTS.md"), "\x01".repeat(1024));
      directory = join(directory, "nested");
    }
    await expect(runtime.ssh.run(id, "workspace_context", {
      root: fixture.workspace, paths: [join(directory, "new.py")],
    })).rejects.toMatchObject({
      code: "REMOTE_OPERATION_FAILED", message: expect.stringContaining("fewer paths or skill_directories"),
    });
    expect(await runtime.ssh.run(id, "stat", { path: "AGENTS.md" })).toMatchObject({ exists: true, size: 1024 });
  } finally {
    await runtime?.close();
    await fixture.close();
  }
}, 20000);
