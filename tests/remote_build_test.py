"""Exercise the remote build cache with real files, locks, and cleanup."""
import fcntl
import hashlib
import json
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
    return {"buildId": build_id, "manifest": manifest, "sources": sources}


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
        directory, lease = build_cache.ensure_build(make_payload(identifier, sources))
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
        self.ensure(identifier)
        self.assertEqual(json.loads((directory / "manifest.json").read_text())["created_at"], created)

    def test_corrupt_cache_is_reinstalled_when_unlocked(self):
        identifier = build_id("corrupt")
        directory = self.ensure(identifier)
        (directory / "worker.py").write_text("tampered\n")
        self.assertFalse(build_cache.verify(str(directory), make_payload(identifier)["manifest"]))
        self.ensure(identifier)
        self.assertTrue(build_cache.verify(str(directory), make_payload(identifier)["manifest"]))

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
        build_cache.cleanup(str(self.builds), current)
        self.assertTrue(current_dir.is_dir())
        remaining = [identifier for identifier, directory in others if directory.is_dir()]
        self.assertEqual(len(remaining), build_cache.KEEP_BUILDS)

    def test_cleanup_skips_locked_and_expired_unknown_format(self):
        current = build_id("locked-current")
        self.ensure(current)
        locked = build_id("locked")
        locked_dir = self.ensure(locked)
        handle = os.open(str(locked_dir / ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_SH)
            build_cache.cleanup(str(self.builds), current)
            self.assertTrue(locked_dir.is_dir())
        finally:
            os.close(handle)
        unknown = build_id("unknown-format")
        unknown_dir = self.ensure(unknown)
        manifest = json.loads((unknown_dir / "manifest.json").read_text())
        manifest["format"] = 99
        manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60 * 86400))
        (unknown_dir / "manifest.json").write_text(json.dumps(manifest))
        build_cache.cleanup(str(self.builds), current)
        self.assertTrue(unknown_dir.is_dir())

    def test_cleanup_removes_stale_temporary_install(self):
        current = build_id("temp-current")
        self.ensure(current)
        temporary = self.builds / ".tmp-old"
        temporary.mkdir(mode=0o700)
        old = time.time() - 2 * 86400
        os.utime(temporary, (old, old))
        build_cache.cleanup(str(self.builds), current)
        self.assertFalse(temporary.exists())


if __name__ == "__main__":
    unittest.main()
