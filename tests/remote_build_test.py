"""Exercise the remote build cache with real files, locks, and cleanup."""
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import subprocess
import threading
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
import build_cache


SOURCES = {
    "worker.py": "worker source\n",
    "file_ops.py": "file ops source\n",
    "helper.py": "helper source\n",
    "archive.py": "archive source\n",
    "build_cache.py": "build cache source\n",
}


def make_payload(build_id, sources=SOURCES):
    """Build the local manifest shape without executing any source."""
    hashes = {name: hashlib.sha256(value.encode("utf-8")).hexdigest() for name, value in sources.items()}
    manifest = {
        "format": 1,
        "build_id": build_id,
        "protocol": 1,
        "min_python": "3.8",
        "archive_format": 1,
        "server_version": "0.2.0",
        "sources": hashes,
    }
    return {"buildId": build_id, "manifest": manifest}


def build_id(value):
    """Return a deterministic 64-character build identifier for tests."""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


class BuildCacheTests(unittest.TestCase):
    """Keep every test inside a private HOME and temporary build root."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="neverssh-build-test-")
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"HOME": str(self.root)})
        self.environment.start()
        self.builds = self.root / ".neverssh" / "builds"

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def ensure(self, identifier, sources=SOURCES):
        """Install or reuse a build and release its shared lease after the call."""
        directory, lease = build_cache.ensure_build(make_payload(identifier, sources), sources)
        os.close(lease)
        return Path(directory)

    def test_installs_verifies_and_reuses_an_immutable_build(self):
        identifier = build_id("first")
        directory = self.ensure(identifier)
        self.assertTrue(build_cache.verify(str(directory), make_payload(identifier)["manifest"]))
        manifest = json.loads((directory / "manifest.json").read_text())
        self.assertEqual(manifest["build_id"], identifier)
        self.assertEqual(manifest["format"], build_cache.BUILD_FORMAT)
        created = manifest["created_at"]
        with patch.object(build_cache, "verify", side_effect=AssertionError("warm rehash")), \
                patch.object(build_cache, "cleanup_builds", side_effect=AssertionError("warm cleanup")):
            self.ensure(identifier)
        self.assertEqual(json.loads((directory / "manifest.json").read_text())["created_at"], created)

    def test_corrupt_cache_is_reinstalled_when_unlocked(self):
        identifier = build_id("corrupt")
        directory = self.ensure(identifier)
        (directory / "manifest.json").write_text("{}")
        self.assertFalse(build_cache.verify(str(directory), make_payload(identifier)["manifest"]))
        self.ensure(identifier)
        self.assertTrue(build_cache.verify(str(directory), make_payload(identifier)["manifest"]))

    def test_invalid_sources_leave_no_installed_build(self):
        identifier = build_id("invalid-source")
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            build_cache.ensure_build(make_payload(identifier), {**SOURCES, "worker.py": "wrong"})
        self.assertFalse((self.builds / identifier).exists())
        self.assertEqual(list(self.builds.glob(".stage-*")), [])

    def test_cache_miss_releases_guard_until_sources_arrive_and_rechecks_competing_install(self):
        identifier = build_id("sources-on-demand")
        remaining = {name: value for name, value in SOURCES.items() if name != "build_cache.py"}

        def deliver_sources():
            with (self.builds / ".lock").open("r+b") as guard:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.ensure(identifier)
            return json.dumps(remaining).encode()

        def acquire():
            payload = dict(make_payload(identifier), bootstrap=SOURCES["build_cache.py"])
            directory, lease = build_cache.acquire_build(payload)
            os.close(lease)
            return directory

        with patch.object(sys, "stdin") as input_stream, patch.object(sys, "stdout", new_callable=io.StringIO) as output, \
                patch.object(build_cache, "staged_build", wraps=build_cache.staged_build) as install:
            input_stream.buffer.readline.side_effect = deliver_sources
            directory = acquire()
            self.assertEqual(acquire(), directory)
            self.assertEqual(output.getvalue().splitlines(), ['{"type":"need_sources"}'])
            input_stream.buffer.readline.assert_called_once()
            install.assert_called_once()

    def test_repair_keeps_competing_bootstrap_off_the_retired_lock(self):
        identifier = build_id("competing-repair")
        directory, lease = build_cache.ensure_build(make_payload(identifier), SOURCES)
        lock_path = Path(directory) / ".lock"
        try:
            (Path(directory) / "manifest.json").write_text("{}")
            with self.assertRaisesRegex(RuntimeError, "currently in use"):
                self.ensure(identifier)
            self.assertTrue(os.path.samestat(os.fstat(lease), lock_path.stat()))
        finally:
            os.close(lease)

        old_inode = lock_path.stat()
        self.ensure(identifier)
        self.assertFalse(os.path.samestat(old_inode, lock_path.stat()))
        directory, lease = build_cache.ensure_build(make_payload(identifier))
        try:
            self.assertTrue(os.path.samestat(os.fstat(lease), lock_path.stat()))
        finally:
            os.close(lease)

    def sweep(self, current):
        build_cache.cleanup_builds(str(self.builds), current)

    def test_cleanup_rechecks_a_lease_acquired_after_the_scan(self):
        current = build_id("cleaner")
        self.ensure(current)
        identifier = build_id("became-active")
        old = self.ensure(identifier)
        manifest = json.loads((old / "manifest.json").read_text())
        manifest["created_at"] = "2000-01-01T00:00:00Z"
        (old / "manifest.json").write_text(json.dumps(manifest))
        guard = build_cache.cache_guard
        leases = []

        @contextmanager
        def acquire_before_retirement(builds, mode):
            if mode == fcntl.LOCK_EX and not leases:
                _, lease = build_cache.ensure_build(make_payload(identifier))
                leases.append(lease)
            with guard(builds, mode):
                yield

        try:
            with patch.object(build_cache, "cache_guard", acquire_before_retirement):
                self.sweep(current)
            self.assertEqual(len(leases), 1)
            self.assertTrue(os.path.samestat(os.fstat(leases[0]), (old / ".lock").stat()))
        finally:
            for lease in leases:
                os.close(lease)
        self.sweep(current)
        self.assertFalse(old.exists())

    def test_warm_connection_proceeds_during_slow_retired_build_deletion(self):
        current = build_id("warm")
        self.ensure(current)
        old = self.ensure(build_id("expired"))
        manifest = json.loads((old / "manifest.json").read_text())
        manifest["created_at"] = "2000-01-01T00:00:00Z"
        (old / "manifest.json").write_text(json.dumps(manifest))
        deleting, resume = threading.Event(), threading.Event()
        removed = []
        rmtree = shutil.rmtree

        def slow_remove(path):
            deleting.set()
            resume.wait(5)
            rmtree(path)
            removed.append(path)

        with patch.object(shutil, "rmtree", slow_remove):
            cleaner = threading.Thread(target=self.sweep, args=(current,))
            cleaner.start()
            try:
                self.assertTrue(deleting.wait(3))
                # Fail immediately if deletion holds even a shared global lock:
                # older warm clients take the exclusive lock.
                with (self.builds / ".lock").open("rb+") as guard:
                    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                directory, lease = build_cache.ensure_build(make_payload(current))
                os.close(lease)
                self.assertEqual(Path(directory).name, current)
                self.assertFalse(removed)
            finally:
                resume.set()
                cleaner.join(5)
        self.assertEqual(len(removed), 1)
        self.assertFalse(old.exists())

    def test_warm_import_failure_repairs_once_in_the_same_bootstrap(self):
        bootstrap = Path(build_cache.__file__).read_text()
        sources = dict(SOURCES, **{
            "worker.py": "from file_ops import word\nclass Worker:\n def __init__(self,p): pass\n def run(self): print(word)\n",
            "file_ops.py": "word = 'ready'\n",
            "build_cache.py": bootstrap,
        })
        identifier = build_id("warm import repair")
        directory = self.ensure(identifier, sources)
        payload = dict(make_payload(identifier, sources), bootstrap=bootstrap)
        protocol = json.dumps(payload) + "\n" + json.dumps({k: v for k, v in sources.items() if k != "build_cache.py"}) + "\n"
        def connect():
            return subprocess.run([sys.executable, "-I", "-B", "-c",
                                   'import json,sys; payload=json.loads(sys.stdin.buffer.readline()); exec(payload["bootstrap"])'],
                                  input=protocol, capture_output=True, text=True, timeout=5)
        for damaged in ("worker.py", "file_ops.py"):
            with self.subTest(damaged=damaged):
                (directory / damaged).unlink()
                repaired = connect()
                self.assertEqual(repaired.returncode, 0, repaired.stderr)
                self.assertEqual(repaired.stdout.splitlines(), ['{"type":"need_sources"}', "ready"])
                self.assertEqual(connect().stdout.splitlines(), ["ready"])
        _, lease = build_cache.ensure_build(payload)
        try:
            (directory / "worker.py").unlink()
            busy = connect()
            self.assertEqual(busy.returncode, 3)
            self.assertIn("currently in use", busy.stderr)
            self.assertEqual(busy.stdout, "")
        finally:
            os.close(lease)

    def test_cleanup_keeps_current_and_newest_unlocked_builds(self):
        current = build_id("current")
        current_dir = self.ensure(current)
        others = []
        for index in range(3):
            identifier = build_id("other-%d" % index)
            directory = self.ensure(identifier)
            manifest = json.loads((directory / "manifest.json").read_text())
            manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3600))
            (directory / "manifest.json").write_text(json.dumps(manifest))
            others.append((identifier, directory))
        self.sweep(current)
        self.assertTrue(current_dir.is_dir())
        remaining = [identifier for identifier, directory in others if directory.is_dir()]
        self.assertEqual(len(remaining), build_cache.KEEP_BUILDS)

    def test_cleanup_skips_locked_and_expired_unknown_format(self):
        current = build_id("locked-current")
        self.ensure(current)
        locked = build_id("locked")
        locked_dir = self.ensure(locked)
        manifest = json.loads((locked_dir / "manifest.json").read_text())
        manifest["created_at"] = "2000-01-01T00:00:00Z"
        (locked_dir / "manifest.json").write_text(json.dumps(manifest))
        handle = os.open(str(locked_dir / ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_SH)
            self.sweep(current)
            self.assertTrue(locked_dir.is_dir())
        finally:
            os.close(handle)
        self.sweep(current)
        self.assertFalse(locked_dir.exists())
        unknown = build_id("unknown-format")
        unknown_dir = self.ensure(unknown)
        manifest = json.loads((unknown_dir / "manifest.json").read_text())
        manifest["format"] = 99
        manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60 * 86400))
        (unknown_dir / "manifest.json").write_text(json.dumps(manifest))
        self.sweep(current)
        self.assertTrue(unknown_dir.is_dir())

    def test_cleanup_removes_stale_temporary_install(self):
        current = build_id("temp-current")
        self.ensure(current)
        temporary = self.builds / ".tmp-old"
        temporary.mkdir(mode=0o700)
        old = time.time() - 2 * 86400
        os.utime(temporary, (old, old))
        self.sweep(current)
        self.assertFalse(temporary.exists())


if __name__ == "__main__":
    unittest.main()
