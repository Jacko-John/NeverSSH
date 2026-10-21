"""Check file-response backpressure without depending on operating-system pipe capacity."""
import base64
import json
import os
from pathlib import Path
import selectors
import sys
import time
import types
import unittest


# Load the bootstrap-owned module without running its connection event loop.
source = Path(__file__).resolve().parents[1] / "src" / "remote" / "worker.py"
worker_module = types.ModuleType("neverssh_worker_output_test")
worker_module.payload = {"archiveSource": "", "fileOpsSource": ""}
sys.modules[worker_module.__name__] = worker_module
exec(compile(source.read_text().rsplit("\nWorker(payload).run()", 1)[0], str(source), "exec"),
     worker_module.__dict__)


class WorkerOutputTests(unittest.TestCase):
    """Model a peer that stops reading, then drains all queued responses."""

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
