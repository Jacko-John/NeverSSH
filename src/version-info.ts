/** Version and compatibility constants shared by the local MCP server and remote bundle. */
import { createHash } from "node:crypto";
import archiveSource from "./remote/archive.py" with { type: "text" };
import buildCacheSource from "./remote/build_cache.py" with { type: "text" };
import fileOpsSource from "./remote/file_ops.py" with { type: "text" };
import helperSource from "./remote/helper.py" with { type: "text" };
import workerSource from "./remote/worker.py" with { type: "text" };

export const SERVER_VERSION = "0.2.1";
export const PROTOCOL_VERSION = 1;
export const MIN_PYTHON = "3.8";
export const ARCHIVE_FORMAT = 1;

/** Sources are immutable and content-addressed; any change creates a new remote build. */
export const BUILD_SOURCES = {
  "archive.py": archiveSource,
  "build_cache.py": buildCacheSource,
  "file_ops.py": fileOpsSource,
  "helper.py": helperSource,
  "worker.py": workerSource,
};

export const SOURCE_HASHES = Object.fromEntries(
  Object.entries(BUILD_SOURCES).map(([name, source]) => [name, createHash("sha256").update(source).digest("hex")]),
);

export const BUILD_ID = createHash("sha256").update(JSON.stringify({
  protocol: PROTOCOL_VERSION, minPython: MIN_PYTHON, archiveFormat: ARCHIVE_FORMAT, sources: SOURCE_HASHES,
})).digest("hex");

export const BUILD_MANIFEST = {
  format: 1,
  build_id: BUILD_ID,
  protocol: PROTOCOL_VERSION,
  min_python: MIN_PYTHON,
  archive_format: ARCHIVE_FORMAT,
  server_version: SERVER_VERSION,
  sources: SOURCE_HASHES,
};
