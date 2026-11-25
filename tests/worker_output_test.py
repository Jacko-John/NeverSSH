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
import threading
import time
import types
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
import worker as worker_module


class WorkerOutputTests(unittest.TestCase):
    """Model a peer that stops reading, then drains all queued responses."""

    def test_helper_frames_forward_partial_json_and_preserve_diagnostic_bytes(self):
        records = []
        output = worker_module.Worker.__new__(worker_module.Worker)
        output.emit = records.append
        key = types.SimpleNamespace(fd=1)
        chunks = (b'{"event":"output","base64":"', b'//4="}\n', b'bad byte: \xff')
        with patch.object(os, "read", side_effect=chunks):
            for stream in ("stdout", "stdout", "stderr"):
                worker_module.Worker.read_stream(output, key, "1", stream)
        self.assertEqual([record["type"] for record in records], ["stdout_text", "stdout_text", "stderr"])
        self.assertEqual("".join(record["text"] for record in records[:2]).encode("ascii"), b"".join(chunks[:2]))
        self.assertEqual(base64.b64decode(records[2]["base64"]), chunks[2])

    def test_json_chunks_round_trip_under_the_receiver_limit(self):
        output = worker_module.Worker.__new__(worker_module.Worker)
        records = []
        output.emit = records.append
        chunks = [b"A+/=" * 4096, b"\x7f" * 16384, b'\\"' * 8192, b"\xe4\xb8", b"\xad end"]
        for chunk in chunks:
            output.emit_json_chunk("1", chunk)
        self.assertEqual(records[0]["type"], "stdout_text")
        for chunk, record in zip(chunks, records):
            self.assertLessEqual(len(json.dumps(record)), 65536)
            restored = record["text"].encode("ascii") if "text" in record else base64.b64decode(record["base64"])
            self.assertEqual(restored, chunk)

    def test_file_completion_wakes_the_selector_for_success_and_failure(self):
        worker = worker_module.Worker.__new__(worker_module.Worker)
        worker.wakeup_lock = threading.Lock()
        reader, worker.wakeup_writer = os.pipe()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(reader, selectors.EVENT_READ)
                for execute in (lambda _: "ready", lambda _: 1 / 0):
                    request = worker_module.FileRequest(execute, {}, worker.wake)
                    self.assertTrue(selector.select(1))
                    self.assertEqual(os.read(reader, 1), b"\0")
                    self.assertTrue(request.done)
                    request.thread.join()
        finally:
            os.close(worker.wakeup_writer)
            os.close(reader)

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
                    with patch.object(worker, "emit", side_effect=records.append), patch.object(worker.pool, "release"):
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
                worker.requests[str(index)] = worker_module.FileRequest(lambda _: {"content": content}, {}, worker.wake)
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
                if record["type"] == "stdout_text":
                    outputs[request_id].extend(record["text"].encode("ascii"))
                elif record["type"] == "stdout":
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
