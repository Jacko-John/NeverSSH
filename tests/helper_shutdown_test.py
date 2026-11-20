"""Check archive finalization after the observed Darwin zombie-group signal failure."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest


REMOTE = Path(__file__).resolve().parents[1] / "src" / "remote"
BOOTSTRAP = """import errno,json,os,subprocess,sys,types
from pathlib import Path
archive = types.ModuleType("neverssh_archive")
exec(compile(Path(sys.argv[1]).read_text(), sys.argv[1], "exec"), archive.__dict__)
sys.modules["neverssh_archive"] = archive
original_popen = subprocess.Popen
def exited_command(*args, **kwargs):
    child = original_popen(*args, **kwargs)
    child.wait(timeout=3)
    return child
subprocess.Popen = exited_command
if sys.argv[3] == "permission-error":
    def denied_signal(*args):
        raise PermissionError(errno.EPERM, "Operation not permitted")
    os.killpg = denied_signal
payload = {"request": json.loads(sys.stdin.buffer.readline())}
exec(compile(Path(sys.argv[2]).read_text(), sys.argv[2], "exec"))
"""


class HelperShutdownTests(unittest.TestCase):
    """Exercise the real helper and archives without SSH or the user's home directory."""

    def run_helper(self, mode):
        """Run the complete helper protocol while holding its control pipe open."""
        archive_module = types.ModuleType("neverssh_archive")
        exec(compile((REMOTE / "archive.py").read_text(), str(REMOTE / "archive.py"), "exec"),
             archive_module.__dict__)
        with tempfile.TemporaryDirectory(prefix="neverssh-helper-shutdown-") as temporary:
            home = Path(temporary)
            store = archive_module.ArchiveStore(65536, 1048576, str(home / ".neverssh"))
            session = store.new_session("1234abcd")
            request = {"connectionId": "1234abcd", "cwd": temporary, "maxTaskOutputBytes": 65536,
                       "maxArchiveBytes": 1048576,
                       "args": {"taskId": "task_12345678", "command": "printf retained"}}
            child = None
            try:
                # The real Bash has exited before the helper begins draining its pipes. Inject only
                # Darwin's observed zombie-group syscall error so the schedule is portable to Linux.
                child = subprocess.Popen([sys.executable, "-I", "-B", "-u", "-c", BOOTSTRAP,
                                          str(REMOTE / "archive.py"), str(REMOTE / "helper.py"), mode],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         env=dict(os.environ, HOME=temporary))
                child.stdin.write(json.dumps(request).encode() + b"\n")
                child.stdin.flush()
                child.wait(timeout=5)
                events = [json.loads(line) for line in child.stdout.read().splitlines()]
                error = child.stderr.read().decode()
                prefix = home / ".neverssh" / "sessions" / "1234abcd" / "task_12345678"
                metadata = json.loads(prefix.with_suffix(".meta.json").read_text())
                return child.returncode, events, error, metadata, prefix.with_suffix(".log").read_bytes()
            finally:
                if child is not None:
                    if child.poll() is None:
                        child.kill()
                    child.wait()
                    for pipe in (child.stdin, child.stdout, child.stderr):
                        pipe.close()
                os.close(session)
                store.close()

    def test_exited_group_permission_error_cannot_skip_final_metadata(self):
        code, events, error, metadata, retained = self.run_helper("permission-error")
        self.assertNotEqual(code, 0, error)
        self.assertTrue(any(event.get("event") == "started" for event in events))
        self.assertTrue(any(event.get("event") == "output" for event in events))
        self.assertTrue(retained.endswith(b"retained"))
        self.assertIn("finished_at", metadata)
        self.assertEqual(metadata["output_bytes"], len(b"retained"))
        self.assertFalse(metadata["output_complete"])
        self.assertEqual(events[-1]["ok"], False)
        self.assertEqual(events[-1]["error"]["code"], "PermissionError")

    def test_normal_exited_group_keeps_success_and_complete_metadata(self):
        code, events, error, metadata, retained = self.run_helper("normal")
        self.assertEqual(code, 0, error)
        self.assertTrue(retained.endswith(b"retained"))
        self.assertIn("finished_at", metadata)
        self.assertEqual(metadata["output_bytes"], len(b"retained"))
        self.assertTrue(metadata["output_complete"])
        self.assertEqual(events[-1]["event"], "exit")
        self.assertEqual(events[-1]["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
