"""Exercise the helper's process notifications, output previews, and archive finalization."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest


REMOTE = Path(__file__).resolve().parents[1] / "src" / "remote"
BOOTSTRAP = """import errno,json,os,subprocess,sys,types
from pathlib import Path
archive = types.ModuleType("neverssh_archive")
exec(compile(Path(sys.argv[1]).read_text(), sys.argv[1], "exec"), archive.__dict__)
sys.modules["archive"] = archive
original_popen = subprocess.Popen
def exited_command(*args, **kwargs):
    child = original_popen(*args, **kwargs)
    child.wait(timeout=3)
    return child
if sys.argv[3] in ("normal", "permission-error"):
    subprocess.Popen = exited_command
if sys.argv[3] == "closed-pipes":
    import selectors
    select_events = selectors.DefaultSelector.select
    def release_when_waiting(selector, timeout=None):
        if not any(key.data in ("stdout", "stderr") for key in selector.get_map().values()):
            assert timeout is None, "An idle helper must wait for SIGCHLD instead of polling"
            Path("release").touch()
        return select_events(selector, timeout)
    selectors.DefaultSelector.select = release_when_waiting
if sys.argv[3] == "permission-error":
    def denied_signal(*args):
        raise PermissionError(errno.EPERM, "Operation not permitted")
    os.killpg = denied_signal
payload = {"request": json.loads(sys.stdin.buffer.readline())}
exec(compile(Path(sys.argv[2]).read_text(), sys.argv[2], "exec"))
sys.exit(run_task(payload["request"], bytearray()))
"""


class HelperShutdownTests(unittest.TestCase):
    """Exercise the real helper and archives without SSH or the user's home directory."""

    def run_helper(self, mode, command="printf retained", limit=65536, action=None):
        """Run the complete helper protocol while holding its control pipe open."""
        archive_module = types.ModuleType("neverssh_archive")
        exec(compile((REMOTE / "archive.py").read_text(), str(REMOTE / "archive.py"), "exec"),
             archive_module.__dict__)
        with tempfile.TemporaryDirectory(prefix="neverssh-helper-shutdown-") as temporary:
            home = Path(temporary)
            store = archive_module.ArchiveStore(limit, 1048576, str(home / ".neverssh"))
            session = store.new_session("1234abcd")
            request = {"connectionId": "1234abcd", "cwd": temporary, "maxTaskOutputBytes": limit,
                       "maxArchiveBytes": 1048576,
                       "args": {"taskId": "task_12345678", "command": command}}
            child = None
            output = tempfile.TemporaryFile()
            try:
                # The real Bash has exited before the helper begins draining its pipes. Inject only
                # Darwin's observed zombie-group syscall error so the schedule is portable to Linux.
                child = subprocess.Popen([sys.executable, "-I", "-B", "-u", "-c", BOOTSTRAP,
                                          str(REMOTE / "archive.py"), str(REMOTE / "helper.py"), mode],
                                         stdin=subprocess.PIPE, stdout=output, stderr=subprocess.PIPE,
                                         env=dict(os.environ, HOME=temporary))
                child.stdin.write(json.dumps(request).encode() + b"\n")
                child.stdin.flush()
                if action:
                    deadline = time.monotonic() + 3
                    while not (home / "ready").exists():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    if action == "disconnect":
                        child.stdin.close()
                    elif action == "terminate":
                        child.terminate()
                    else:
                        child.stdin.write(b'{"action":"stop"}\n')
                        child.stdin.flush()
                child.wait(timeout=5)
                output.seek(0)
                events = [json.loads(line) for line in output.read().splitlines()]
                error = child.stderr.read().decode()
                prefix = home / ".neverssh" / "sessions" / "1234abcd" / "task_12345678"
                metadata = json.loads(prefix.with_suffix(".meta.json").read_text())
                return child.returncode, events, error, metadata, prefix.with_suffix(".log").read_bytes()
            finally:
                if child is not None:
                    if child.poll() is None:
                        child.kill()
                    child.wait()
                    for pipe in (child.stdin, child.stderr):
                        pipe.close()
                output.close()
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

    def test_unobserved_long_output_sends_only_the_initial_pushes_and_final_tail(self):
        code, events, error, metadata, archive = self.run_helper("long-output", "printf '%262144s' final", 524288)
        self.assertEqual(code, 0, error)
        pushes = [event for event in events if event.get("event") == "output"]
        tails = [event for event in events if event.get("event") == "tail"]
        self.assertLessEqual(sum(len(base64.b64decode(event["base64"])) for event in pushes), 65536)
        self.assertEqual(len(tails), 1)
        tail = base64.b64decode(tails[0]["base64"])
        self.assertIn("before", tails[0])
        self.assertLessEqual(len(tail), 65536)
        self.assertEqual(sum(tails[0]["lengths"]), len(tail))
        self.assertTrue(tail.endswith(b"final"))
        self.assertTrue(archive.endswith(tail))
        self.assertEqual(tails[0]["outputBytes"], len(archive))
        self.assertEqual(metadata["output_bytes"], 262144)

    def test_exit_after_both_output_pipes_close_wakes_a_blocked_helper(self):
        command = "exec 1>&- 2>&-; while [ ! -f release ]; do sleep 0.01; done; exit 19"
        code, events, error, metadata, _ = self.run_helper("closed-pipes", command)
        self.assertEqual(code, 0, error)
        self.assertEqual(events[-1]["exitCode"], 19)
        self.assertTrue(metadata["output_complete"])

    def test_idle_stop_and_control_eof_escalate_after_bash_closes_its_output(self):
        for action, reason in (("stop", "cancelled"), ("disconnect", "disconnected")):
            with self.subTest(action=action):
                command = "trap '' TERM; exec 1>&- 2>&-; touch ready; exec sleep 30"
                code, events, error, _, _ = self.run_helper("live", command, action=action)
                self.assertEqual(code, 0, error)
                self.assertEqual(events[-1]["reason"], reason)
                self.assertEqual(events[-1]["exitCode"], -9)

    def test_exited_bash_with_a_descendant_holding_its_pipes_is_drained_and_reaped(self):
        code, events, error, _, archive = self.run_helper("live", "(printf descendant; sleep 15) & exit 0")
        self.assertEqual(code, 0, error)
        self.assertEqual(events[-1]["exitCode"], 0)
        self.assertTrue(archive.endswith(b"descendant"))

    def test_supervisor_signal_wakes_an_idle_helper_and_stops_its_child(self):
        command = "exec 1>&- 2>&-; touch ready; exec sleep 30"
        code, events, error, _, _ = self.run_helper("live", command, action="terminate")
        self.assertEqual(code, 0, error)
        self.assertEqual(events[-1]["reason"], "disconnected")
        self.assertEqual(events[-1]["exitCode"], -15)


if __name__ == "__main__":
    unittest.main()
