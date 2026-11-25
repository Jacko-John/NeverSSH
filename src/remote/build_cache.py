"""Install, verify, lease, and clean versioned remote worker builds.

The bootstrap sends this source over SSH before any cached code runs. It keeps
the on-disk build immutable and holds a shared lease for the worker lifetime.
"""
from contextlib import contextmanager
import calendar
import importlib
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


def installed(build_dir, expected):
    """Recognize a private, atomically published installation by its build manifest."""
    if not os.path.isdir(build_dir) or os.path.islink(build_dir):
        return False
    private_directory(build_dir)
    try:
        manifest = json.loads(read_text(manifest_path(build_dir)))
    except (OSError, ValueError, UnicodeError):
        return False
    if not isinstance(manifest, dict) or manifest.get("format") != BUILD_FORMAT:
        return False
    for key in ("build_id", "protocol", "min_python", "archive_format", "sources"):
        if manifest.get(key) != expected.get(key):
            return False
    return True


def verify(build_dir, expected):
    """Check every installed byte before publishing a new build."""
    if not installed(build_dir, expected):
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


@contextmanager
def staged_build(builds, expected, sources):
    """Write and verify before taking the publication lock; protect slow active stages."""
    temporary = tempfile.mkdtemp(prefix=".stage-", dir=builds)
    lease = private_file(os.path.join(temporary, ".lock"), os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(lease, fcntl.LOCK_SH)
        for name, source in sources.items():
            if not isinstance(name, str) or not name or "/" in name or name in (".", ".."):
                raise RuntimeError("Invalid build source name")
            write_file(os.path.join(temporary, name), source.encode("utf-8"))
        manifest = dict(expected)
        manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_file(manifest_path(temporary), json.dumps(manifest, sort_keys=True).encode("utf-8"))
        if not verify(temporary, expected):
            raise RuntimeError("Remote build verification failed")
        yield temporary
    finally:
        os.close(lease)
        if os.path.isdir(temporary):
            shutil.rmtree(temporary)


def created_at(value):
    """Parse the UTC manifest timestamp used only for cache retention."""
    try:
        return calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None


def unused_build(path):
    """Probe the lease under the cache guard, which blocks new leases until deletion finishes."""
    descriptor = private_file(os.path.join(path, ".lock"), os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True
    finally:
        # NFS can keep an unlinked, open file in its directory until the last close.
        os.close(descriptor)


@contextmanager
def cache_guard(builds, mode):
    guard = private_file(os.path.join(builds, ".lock"), os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(guard, mode)
        yield
    finally:
        os.close(guard)


def retire(path, prefix=".tmp-"):
    """Unpublish under the guard. The caller deletes the unique directory after unlocking."""
    trash = tempfile.mkdtemp(prefix=prefix, dir=os.path.dirname(path))
    try:
        os.rename(path, os.path.join(trash, "retired"))
    except BaseException:
        os.rmdir(trash)
        raise
    return trash


def cleanup_builds(builds, current_id):
    """Scan outside the publication lock; recheck identity and lease before each rename."""
    candidates = []
    expired = []
    for name in os.listdir(builds):
        path = os.path.join(builds, name)
        try:
            info = os.lstat(path)
            if not stat.S_ISDIR(info.st_mode):
                continue
            if name.startswith(".retired-"):
                expired.append((name, info))
                continue
            if name.startswith((".tmp-", ".stage-")):
                if time.time() - info.st_mtime >= 86400:
                    expired.append((name, info))
                continue
            if name == current_id or not BUILD_ID.fullmatch(name):
                continue
            # The guard also interoperates with older clients deleting leaf lock files.
            with cache_guard(builds, fcntl.LOCK_SH):
                if not os.path.isdir(path) or not unused_build(path):
                    continue
                manifest = json.loads(read_text(manifest_path(path)))
            if not isinstance(manifest, dict) or manifest.get("format") != BUILD_FORMAT:
                continue
            when = created_at(manifest.get("created_at"))
            if when is None:
                continue
            if time.time() - when > RETENTION_SECONDS:
                expired.append((name, info))
            else:
                candidates.append((when, name, info))
        except (OSError, ValueError, UnicodeError):
            continue
    candidates.sort(reverse=True)
    expired.extend((name, info) for _, name, info in candidates[KEEP_BUILDS:])
    for name, observed in expired:
        path = os.path.join(builds, name)
        try:
            with cache_guard(builds, fcntl.LOCK_EX):
                if not os.path.samestat(observed, os.lstat(path)):
                    continue
                if not name.startswith((".tmp-", ".retired-")) and not unused_build(path):
                    continue
                trash = retire(path)
            shutil.rmtree(trash)
        except FileNotFoundError:
            continue


def ensure_build(payload, sources=None, rejected_lease=None):
    """Lease an installed build, rechecking after staging if another client published first."""
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

    def existing_lease():
        if installed(build_dir, expected):
            lease = private_file(os.path.join(build_dir, ".lock"), os.O_RDWR | os.O_CREAT)
            try:
                if rejected_lease is None or not os.path.samestat(os.fstat(lease), rejected_lease):
                    fcntl.flock(lease, fcntl.LOCK_SH)
                    return build_dir, lease
            except BaseException:
                os.close(lease)
                raise
            os.close(lease)
        if os.path.isdir(build_dir) and not unused_build(build_dir):
            raise RuntimeError("Remote build is corrupt and currently in use")
        return None

    with cache_guard(builds, fcntl.LOCK_SH):
        existing = existing_lease()
    if existing or sources is None:
        return existing

    with staged_build(builds, expected, sources) as temporary:
        with cache_guard(builds, fcntl.LOCK_EX):
            existing = existing_lease()
            if existing:
                return existing
            if os.path.isdir(build_dir):
                retire(build_dir, prefix=".retired-")
            os.rename(temporary, build_dir)
            lease = private_file(os.path.join(build_dir, ".lock"), os.O_RDWR)
            fcntl.flock(lease, fcntl.LOCK_SH)
            payload["installedBuild"] = True
            return build_dir, lease


def acquire_build(payload, rejected_lease=None):
    """Ask for sources at most once per handshake, outside filesystem locks."""
    build = ensure_build(payload, rejected_lease=rejected_lease)
    if build is not None:
        return build
    bootstrap = payload.pop("bootstrap")
    print('{"type":"need_sources"}', flush=True)
    sources = json.loads(sys.stdin.buffer.readline())
    if not isinstance(sources, dict):
        raise ValueError("Invalid remote build sources")
    sources["build_cache.py"] = bootstrap
    if sources.keys() != payload["manifest"]["sources"].keys():
        raise ValueError("Remote build sources do not match manifest")
    return ensure_build(payload, sources, rejected_lease=rejected_lease)


def main(payload):
    """Check the interpreter, install/verify the build, then execute the worker."""
    if sys.version_info < (3, 8):
        fail(2, "NeverSSH requires Python 3.8 or newer; found " + sys.version.split()[0])
    try:
        build_dir, lease = acquire_build(payload)
        payload["buildDir"] = build_dir
        sys.path.insert(0, build_dir)
        try:
            from worker import Worker
        except Exception:
            # Healthy source bytes indicate an interpreter/environment failure. Keep
            # the original diagnostic and avoid downloading the same build again.
            if verify(build_dir, payload["manifest"]) or "bootstrap" not in payload:
                raise
            # Drop our shared lock but pin the rejected inode until a replacement
            # is leased. A concurrent repair can then win without another rehash.
            old_lease = lease
            try:
                fcntl.flock(old_lease, fcntl.LOCK_UN)
                build_dir, lease = acquire_build(payload, rejected_lease=os.fstat(old_lease))
            finally:
                os.close(old_lease)
            for filename in payload["manifest"]["sources"]:
                name = filename[:-3]
                module = sys.modules.get(name)
                if getattr(module, "__file__", None) == os.path.join(build_dir, filename):
                    del sys.modules[name]
            importlib.invalidate_caches()
            from worker import Worker
    except Exception as error:
        fail(3, "NeverSSH remote build setup failed: " + str(error))

    # Keep the shared lease open for the worker's lifetime; O_CLOEXEC hides it from helpers.
    Worker(payload).run()


if __name__ == "__main__":
    main(payload)
