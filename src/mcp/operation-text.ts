/** Concise model-facing text for connection, file, and transfer results. */
import type { RemoteResult } from "../ssh/request-channel";

type Item = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number => typeof value === "number" ? value : 0;
const items = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter((item): item is Item => typeof item === "object" && item !== null) : [];

export function discoverText(value: RemoteResult): string {
  const servers = items(value.servers);
  return servers.length ? servers.map((server) => text(server.host)).join("\n") : "No SSH candidates found.";
}

export function connectText(value: RemoteResult): string {
  return `Connection: ${text(value.connection_id)}`;
}

export function sessionsText(value: RemoteResult): string {
  const sessions = items(value.sessions);
  if (!sessions.length) return "No active connections.";
  return sessions.map((session) =>
    `${text(session.connection_id)}  ${text(session.user)}@${text(session.host)}:${count(session.port)}`).join("\n");
}

export function closeText(value: RemoteResult): string {
  return `Closed ${text(value.connection_id)} (remote cleanup ${text(value.remote_cleanup)}).`;
}

export function readText(value: RemoteResult): string {
  const content = text(value.content);
  const start = count(value.startLine);
  const total = count(value.totalLines);
  if (!content && total === 0) return "File exists but is empty.";
  if (!content && start > total) return `File has ${total} lines; offset ${start} is past the end.`;

  // Match the worker's Python splitlines boundaries, including CRLF as one separator.
  const bodies = content.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (bodies.at(-1) === "") bodies.pop();
  const lines = bodies.map((line, index) => `${String(start + index).padStart(6)}\t${line}`);
  if (value.truncated) {
    lines.push(`PARTIAL view: showing lines ${start}-${count(value.endLine)} of ${total}. Use offset=${count(value.nextLine)} to continue.`);
  }
  return lines.join("\n");
}

export function writeText(value: RemoteResult): string {
  const path = text(value.path);
  return value.created ? `File created successfully at: ${path}` : `The file ${path} has been updated successfully.`;
}

export function editText(value: RemoteResult): string {
  const preview = value.preview as { lines: { line: number; text: string }[]; truncated: boolean };
  const lines = [`The file ${text(value.path)} has been updated successfully.`];
  if (count(value.replacements) > 1) lines.push(`Replaced ${value.replacements} occurrences. Showing the first changed region.`);
  for (const entry of preview.lines) lines.push(`${String(entry.line).padStart(6)}\t${entry.text}`);
  if (!preview.lines.length) lines.push("File is now empty.");
  if (preview.truncated) lines.push("… (preview shortened)");
  return lines.join("\n");
}

export function uploadText(value: RemoteResult): string {
  return `Uploaded ${text(value.localPath)} to ${text(value.path)} (${count(value.bytesWritten)} bytes).\nSHA-256: ${text(value.sha256)}`;
}

export function downloadText(value: RemoteResult): string {
  return `Downloaded ${text(value.path)} to ${text(value.localPath)} (${count(value.size)} bytes).\nSHA-256: ${text(value.sha256)}`;
}
