"""Install, verify, lease, and clean versioned remote worker builds.

The bootstrap sends this source over SSH before any cached code runs. It keeps
the on-disk build immutable and holds a shared lease for the worker lifetime.
"""
import calendar
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time


BUILD_ID = re.compile(r"^[a-f0-9]{64}$")
BUILD_FORMAT = 1
RETENTION_SECONDS = 30 * 24 * 60 * 60
KEEP_BUILDS = 2
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def fail(code, message):
    """Exit with a stable code; the local client maps it to a tool error."""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()
    sys.exit(code)


def private_directory(path):
    """Create or validate an owned, non-symlink build directory."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode):
        raise RuntimeError("Build cache directory must be an owned directory: " + path)
    os.chmod(path, 0o700)


def private_file(path, flags):
    """Open an owned regular file without following links or leaking descriptors."""
    descriptor = os.open(path, flags | NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError("Build cache file must be an owned regular file: " + path)
    os.fchmod(descriptor, 0o600)
    return descriptor


def read_file(path):
    """Read one bounded cache file through the private-file checks."""
    descriptor = private_file(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as handle:
        return handle.read()


def read_text(path):
    """Read cache source as UTF-8 text."""
    return read_file(path).decode("utf-8")


def write_file(path, data):
    """Create one cache file exclusively and make it durable before publishing."""
    descriptor = private_file(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def digest(data):
    """Hash one source file using the same algorithm as the local build manifest."""
    return hashlib.sha256(data).hexdigest()


def manifest_path(build_dir):
    """Place the manifest next to the immutable sources it describes."""
    return os.path.join(build_dir, "manifest.json")


def verify(build_dir, expected):
    """Verify the manifest shape and every source hash before executing cache code."""
    try:
        manifest = json.loads(read_text(manifest_path(build_dir)))
    except (OSError, ValueError, UnicodeError):
        return False
    if not isinstance(manifest, dict) or manifest.get("format") != BUILD_FORMAT:
        return False
    for key in ("build_id", "protocol", "min_python", "archive_format", "sources"):
        if manifest.get(key) != expected.get(key):
            return False
    sources = expected.get("sources")
    if not isinstance(sources, dict):
        return False
    for name, expected_hash in sources.items():
        if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
            return False
        try:
            if digest(read_file(os.path.join(build_dir, name))) != expected_hash:
                return False
        except OSError:
            return False
    return True


def install(build_dir, expected, sources, builds):
    """Write a verified build into a temporary directory, then rename it into place."""
    temporary = tempfile.mkdtemp(prefix=".tmp-", dir=builds)
    os.chmod(temporary, 0o700)
    try:
        for name, source in sources.items():
            if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
                raise RuntimeError("Invalid build source name")
            write_file(os.path.join(temporary, name), source.encode("utf-8"))
        manifest = dict(expected)
        manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_file(manifest_path(temporary), json.dumps(manifest, sort_keys=True).encode("utf-8"))
        try:
            os.rename(temporary, build_dir)
        except OSError:
            # Another connection may have installed the same immutable build.
            if not verify(build_dir, expected):
                raise
    finally:
        if os.path.isdir(temporary):
            shutil.rmtree(temporary)


def created_at(value):
    """Parse the UTC manifest timestamp used only for cache retention."""
    try:
        return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None


def cleanup(builds, current_id):
    """Remove old unlocked builds; the current build keeps its shared lease."""
    candidates = []
    try:
        names = os.listdir(builds)
    except OSError:
        return
    for name in names:
        path = os.path.join(builds, name)
        if name.startswith(".tmp-"):
            try:
                if time.time() - os.lstat(path).st_mtime >= 86400:
                    shutil.rmtree(path)
            except OSError:
                pass
            continue
        if not BUILD_ID.match(name) or name == current_id:
            continue
        try:
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                continue
            lock = private_file(os.path.join(path, ".lock"), os.O_RDWR | os.O_CREAT)
        except OSError:
            continue
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            try:
                manifest = json.loads(read_text(manifest_path(path)))
            except (OSError, ValueError, UnicodeError):
                continue
            if not isinstance(manifest, dict) or manifest.get("format") != BUILD_FORMAT:
                continue
            when = created_at(manifest.get("created_at"))
            if when is None:
                continue
            if time.time() - when > RETENTION_SECONDS:
                shutil.rmtree(path)
                continue
            candidates.append((when, name))
        finally:
            os.close(lock)
    candidates.sort(reverse=True)
    for _, name in candidates[KEEP_BUILDS:]:
        path = os.path.join(builds, name)
        try:
            lock = private_file(os.path.join(path, ".lock"), os.O_RDWR | os.O_CREAT)
        except OSError:
            continue
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            shutil.rmtree(path)
        finally:
            os.close(lock)


def ensure_build(payload):
    """Return the verified build directory and hold a shared lease for this process."""
    home = os.path.expanduser("~")
    base = os.path.join(home, ".neverssh")
    builds = os.path.join(base, "builds")
    private_directory(base)
    private_directory(builds)

    build_id = payload.get("buildId")
    expected = payload.get("manifest")
    if not isinstance(build_id, str) or not BUILD_ID.match(build_id) or not isinstance(expected, dict) \
            or expected.get("build_id") != build_id:
        raise RuntimeError("Invalid remote build manifest")
    build_dir = os.path.join(builds, build_id)

    guard = private_file(os.path.join(builds, ".lock"), os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if not verify(build_dir, expected):
            sources = payload.get("sources")
            if not isinstance(sources, dict):
                raise RuntimeError("Remote build is missing and no sources were provided")
            if os.path.isdir(build_dir):
                repair = private_file(os.path.join(build_dir, ".lock"), os.O_RDWR | os.O_CREAT)
                try:
                    try:
                        fcntl.flock(repair, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise RuntimeError("Remote build is corrupt and currently in use")
                    shutil.rmtree(build_dir)
                finally:
                    os.close(repair)
            install(build_dir, expected, sources, builds)
            if not verify(build_dir, expected):
                raise RuntimeError("Remote build verification failed")
        lease = private_file(os.path.join(build_dir, ".lock"), os.O_RDWR | os.O_CREAT)
        fcntl.flock(lease, fcntl.LOCK_SH)
        cleanup(builds, build_id)
        return build_dir, lease
    finally:
        fcntl.flock(guard, fcntl.LOCK_UN)
        os.close(guard)


def main(payload):
    """Check the interpreter, install/verify the build, then execute the worker."""
    if sys.version_info < (3, 8):
        fail(2, "NeverSSH requires Python 3.8 or newer; found " + sys.version.split()[0])
    try:
        build_dir, lease = ensure_build(payload)
        payload["buildDir"] = build_dir
        payload["fileOpsSource"] = read_text(os.path.join(build_dir, "file_ops.py"))
        payload["archiveSource"] = read_text(os.path.join(build_dir, "archive.py"))
        source = read_text(os.path.join(build_dir, "worker.py"))
    except Exception as error:
        fail(3, "NeverSSH remote build setup failed: " + str(error))

    # Keep the shared lease open for the worker's lifetime; O_CLOEXEC hides it from helpers.
    namespace = {"__name__": "__main__", "__file__": os.path.join(build_dir, "worker.py"), "payload": payload}
    exec(compile(source, namespace["__file__"], "exec"), namespace)


if __name__ == "__main__":
    main(payload)
