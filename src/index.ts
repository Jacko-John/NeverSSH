#!/usr/bin/env bun
/** CLI entry point: stdio MCP by default, or an explicit connection diagnostic. */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config";
import { createServer, Runtime, VERSION } from "./server";

/** Parse the intentionally small CLI without forwarding arbitrary flags to SSH. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("NeverSSH: local MCP tools for remote Linux development\n\nUsage:\n  bun run src/index.ts [--config /absolute/path/config.json]\n  bun run src/index.ts doctor [host] [--config /absolute/path/config.json]\n\nEnvironment: NEVERSSH_CONFIG selects a configuration file.\nThe implicit ./neverssh.config.json is optional. Requires local OpenSSH and remote Python 3.8+.\nWithout a host, doctor lists candidates without connecting.\n");
    return;
  }
  if (argv.length === 1 && argv[0] === "--version") { console.log(VERSION); return; }
  let filename = process.env.NEVERSSH_CONFIG ?? "neverssh.config.json";
  let optionalConfig = process.env.NEVERSSH_CONFIG === undefined;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--config") {
      if (!argv[index + 1]) throw new Error("--config requires a filename");
      filename = argv[++index]!;
      optionalConfig = false;
    } else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (positional.length && (positional[0] !== "doctor" || positional.length > 2)) throw new Error("Expected doctor [host], or no command for MCP stdio");
  const runtime = new Runtime(await loadConfig(filename, optionalConfig));
  if (positional[0] === "doctor") {
    try {
      const host = positional[1];
      if (!host) console.log(JSON.stringify(await runtime.discovery.discover(), null, 2));
      else {
        const connection = await runtime.ssh.connect({ host });
        console.log(JSON.stringify({ ...connection, ...await runtime.ssh.run(String(connection.connection_id), "probe") }, null, 2));
      }
    } finally { await runtime.close(); }
    return;
  }
  const transport = new StdioServerTransport();
  const handle = serveStdio(() => createServer(runtime), {
    transport, onerror: (error) => console.error("NeverSSH MCP:", error.message),
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.close();
    await handle.close();
  };
  // Observe the entry-owned wire, preserving SDK teardown while probe instances come and go.
  const onWireClose = transport.onclose;
  transport.onclose = () => {
    try { onWireClose?.(); }
    finally { void shutdown().catch((error) => console.error(error.message)); }
  };
  for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => { void shutdown().catch((error) => console.error(error.message)); });
}

if (import.meta.main) {
  main().catch((error) => { console.error(`NeverSSH: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
