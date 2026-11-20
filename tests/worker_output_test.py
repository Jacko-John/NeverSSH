"""Check file-response backpressure without depending on operating-system pipe capacity."""
import base64
import io
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


# Load the bootstrap-owned module without running its connection event loop.
source = Path(__file__).resolve().parents[1] / "src" / "remote" / "worker.py"
worker_module = types.ModuleType("neverssh_worker_output_test")
worker_module.payload = {"archiveSource": "", "fileOpsSource": (source.parent / "file_ops.py").read_text(),
                         "readFormatsSource": (source.parent / "read_formats.py").read_text(),
                         "workspaceSource": (source.parent / "workspace.py").read_text()}
sys.modules[worker_module.__name__] = worker_module
exec(compile(source.read_text().rsplit("\nWorker(payload).run()", 1)[0], str(source), "exec"),
     worker_module.__dict__)


class WorkerOutputTests(unittest.TestCase):
    """Model a peer that stops reading, then drains all queued responses."""

    def test_abnormal_helper_exit_cannot_confirm_cleanup(self):
        for exit_codes in ((0,), (2,), (2, 0), (1,), (-signal.SIGTERM,), (-signal.SIGKILL,), (1, 0), (1, 2)):
            with self.subTest(exit_codes=exit_codes):
                worker = worker_module.Worker({
                    "maxFileBytes": 1024, "connectionId": "1234abcd", "buildDir": "unused", "buildId": "unused",
                    "serverVersion": "test", "protocol": 1, "archiveFormat": 1,
                    "maxTaskOutputBytes": 1024, "maxArchiveBytes": 8192,
                })
                records = []
                try:
                    with patch.object(worker, "emit", side_effect=records.append):
                        for index, code in enumerate(exit_codes):
                            process = types.SimpleNamespace(stdin=io.BytesIO(), returncode=code, poll=lambda: code)
                            request = worker_module.ChildRequest(process, bytearray(), open_output_streams=0)
                            worker.requests[str(index)] = request
                            worker.update_requests()
                            self.assertTrue(process.stdin.closed)
                        self.assertEqual(worker.requests, {})
                        worker.stopping = True
                        worker.prepare_output()
                    self.assertEqual([record["code"] for record in records if record["type"] == "close"],
                                     list(exit_codes))
                    self.assertEqual(records[-1], {"type": "bye", "cleanup_confirmed": all(code in (0, 2) for code in exit_codes)})
                finally:
                    worker.selector.close()

    def test_workspace_cancel_and_cleanup_reap_owned_git_processes(self):
        for cleanup in (False, True):
            with self.subTest(cleanup=cleanup), tempfile.TemporaryDirectory(prefix="neverssh-worker-git-") as temporary:
                root = Path(temporary).resolve()
                binary = root / "bin"
                binary.mkdir()
                marker = root / "git.pid"
                executable = binary / "git"
                executable.write_text("#!/bin/sh\nprintf '%s\\n' \"$$\" > " + shlex.quote(str(marker)) +
                                      "\nexec sleep 30\n")
                executable.chmod(0o700)
                worker = worker_module.Worker({
                    "maxFileBytes": 1024, "connectionId": "1234abcd", "buildDir": "unused", "buildId": "unused",
                    "serverVersion": "test", "protocol": 1, "archiveFormat": 1,
                    "maxTaskOutputBytes": 1024, "maxArchiveBytes": 8192,
                })
                with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
                    worker.start_request("workspace", {"op": "workspace_open", "args": {"path": str(root)},
                                                       "cwd": str(root)})
                    request = worker.requests["workspace"]
                    try:
                        deadline = time.monotonic() + 2
                        while not marker.exists() or not marker.read_text().strip():
                            self.assertLess(time.monotonic(), deadline)
                            time.sleep(0.005)
                        pid = int(marker.read_text())
                        if cleanup:
                            worker.cleanup()
                        else:
                            worker.control_request("workspace", {"type": "cancel"})
                            request.thread.join(1)
                        self.assertTrue(request.done)
                        self.assertIsInstance(request.error, InterruptedError)
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
                    finally:
                        request.stop()
                        request.thread.join(6)
                        if not cleanup:
                            worker.cleanup()

    def test_stalled_output_is_bounded_and_resumes_without_losing_or_reordering_bytes(self):
        worker = worker_module.Worker({
            "maxFileBytes": 4 * 1024 * 1024, "connectionId": "1234abcd",
            "buildDir": "unused", "buildId": "unused", "serverVersion": "test",
            "protocol": 1, "archiveFormat": 1, "maxTaskOutputBytes": 1024,
            "maxArchiveBytes": 8192,
        })
        content = "\x01" * 262144
        reader, writer = os.pipe()
        pipe = os.fdopen(reader, "rb", buffering=0)
        try:
            # Completed real file threads must retain their unsent bytes when the peer stalls.
            for index in range(8):
                worker.requests[str(index)] = worker_module.FileRequest(lambda _: {"content": content}, {})
            deadline = time.monotonic() + 5
            while not all(request.done for request in worker.requests.values()):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.001)
            for _ in range(100):
                worker.update_requests()
            self.assertEqual(len(worker.requests), 8)
            self.assertLess(len(worker.outgoing), worker_module.OUTPUT_HIGH_WATER + 32768)

            # Removing readable helper descriptors avoids a busy loop while stdout is blocked.
            worker.selector.register(pipe, selectors.EVENT_READ, ("helper", "stdout"))
            worker.update_output_streams()
            with self.assertRaises(KeyError):
                worker.selector.get_key(pipe)

            # Draining the peer re-enables helper reads and eventually sends close after each response.
            records = []
            while worker.requests or worker.outgoing:
                records.extend(json.loads(line) for line in worker.outgoing.splitlines())
                worker.outgoing.clear()
                worker.update_output_streams()
                self.assertEqual(worker.selector.get_key(pipe).data, ("helper", "stdout"))
                worker.update_requests()
            outputs = {str(index): bytearray() for index in range(8)}
            closed = set()
            for record in records:
                request_id = record["id"]
                self.assertNotIn(request_id, closed)
                if record["type"] == "stdout":
                    outputs[request_id].extend(base64.b64decode(record["base64"]))
                else:
                    self.assertEqual(record["type"], "close")
                    self.assertEqual(record["code"], 0)
                    closed.add(request_id)
            self.assertEqual(len(closed), 8)
            for output in outputs.values():
                self.assertEqual(json.loads(output), {"ok": True, "result": {"content": content}})
        finally:
            worker.selector.close()
            pipe.close()
            os.close(writer)


if __name__ == "__main__":
    unittest.main()
