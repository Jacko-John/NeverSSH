/** Verify local SSH inventory parsing without connections, credentials, or network scanning. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "../src/config";
import { configuredHosts, Discovery } from "../src/discovery";

let root: string;
beforeAll(async () => { root = await mkdtemp("/tmp/neverssh-discovery-test-"); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("discovers quoted aliases and Include globs without inventing wildcard hosts", async () => {
  const includes = join(root, "includes");
  await mkdir(includes);
  const config = join(root, "ssh_config");
  await writeFile(config, `Host = "dev-one" dev-two !excluded *.wildcard\nInclude "${includes}/*.conf"\nInclude %h/generated.conf\n`);
  await writeFile(join(includes, "a.conf"), `Host dev-three # comment\nInclude "${config}"\n`);
  await writeFile(join(includes, "b.conf"), "Host prod-one\nHost *\n");
  expect(await configuredHosts(configSchema.parse({ sshConfig: config }))).toEqual(["dev-one", "dev-three", "dev-two", "prod-one"]);
});

test("returns all candidates in one call and reads current configuration on each call", async () => {
  const config = join(root, "all-hosts.conf");
  const hosts = Array.from({ length: 75 }, (_, index) => `server-${String(index).padStart(3, "0")}`);
  await writeFile(config, `Host ${hosts.join(" ")}\n`);
  const discovery = new Discovery(configSchema.parse({ sshConfig: config }));
  expect(await discovery.discover()).toEqual({ servers: hosts.map((host) => ({ host })) });

  await writeFile(config, "");
  expect(await discovery.discover()).toEqual({ servers: [] });
});
