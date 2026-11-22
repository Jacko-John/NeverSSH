/** Format a remote read and check the complete image response before recording its revision. */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ToolError } from "../errors";
import type { RemoteResult } from "../ssh/request-channel";
import { readText } from "./operation-text";

// Leave envelope headroom below the SDK's default 10 MiB stdio receive buffer.
const MAX_IMAGE_RESPONSE_BYTES = 9 * 1024 * 1024;

function readBlocks(value: RemoteResult): CallToolResult["content"] {
  if (value.kind === "image") {
    const { base64, mimeType } = value;
    if (typeof base64 !== "string" || typeof mimeType !== "string" || !base64 || !mimeType) {
      throw new ToolError("REMOTE_OPERATION_FAILED", "Remote image response is missing image data or its MIME type");
    }
    return [{ type: "image", data: base64, mimeType }];
  }
  if (value.kind !== "document") return [{ type: "text", text: readText(value) }];
  if (!Array.isArray(value.blocks) || !value.blocks.length) {
    throw new ToolError("REMOTE_OPERATION_FAILED", "Remote document response has no content");
  }
  return value.blocks.map(block => {
    if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    throw new ToolError("REMOTE_OPERATION_FAILED", "Invalid content in remote document response");
  });
}

export function readResult(value: RemoteResult, change: "changed" | "superseded" | undefined): CallToolResult {
  const content = readBlocks(value);
  if (change === "superseded") {
    content.push({ type: "text", text: "A later observation recorded different contents. Read again to confirm the current version." });
  } else if (change === "changed") {
    content.push({ type: "text", text: "This file has been modified since it was last read." });
  }
  const response = { content };
  if (content.some(item => item.type === "image") && Buffer.byteLength(JSON.stringify(response)) > MAX_IMAGE_RESPONSE_BYTES) {
    throw new ToolError("OPERATION_FAILED", "Image response exceeds the 9 MiB MCP response budget. Reduce the image size and retry.");
  }
  return response;
}
