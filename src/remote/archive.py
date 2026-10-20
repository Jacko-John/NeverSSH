"""Private command archives, shared disk budgets, and lock-aware fourteen-day retention."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
import re
import stat
import struct
import tempfile
import time


RETENTION_SECONDS = 14 * 24 * 60 * 60
FORMAT = 1
MAX_METADATA_BYTES = 1024 * 1024
CONNECTION_ID = re.compile(r"^[a-f0-9]{8}$")
TASK_ID = re.compile(r"^task_[a-f0-9]{8}$")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class ArchiveError(Exception):
    """Expose a stable error code without treating command output as protocol data."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def utc_timestamp(value):
    """Use UTC ISO timestamps in metadata intended to survive the worker process."""
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def private_directory(path):
    """Refuse symlink directories instead of redirecting archive writes elsewhere."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ArchiveError("ARCHIVE_UNAVAILABLE", "Archive directory must be owned by the remote user and cannot be a symlink")
    os.chmod(path, 0o700)


def private_file(path, flags):
    """Open an owned regular file, keeping descriptors out of child commands."""
    descriptor = os.open(path, flags | NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(descriptor)
        raise ArchiveError("ARCHIVE_UNAVAILABLE", "Archive files must be owned regular files")
    os.fchmod(descriptor, 0o600)
    return descriptor


def write_metadata(path, value):
    """Replace metadata atomically in its own session directory."""
    descriptor, temporary = tempfile.mkstemp(prefix=".metadata-", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_metadata(path):
    """Read bounded metadata through the same owned-regular-file checks."""
    descriptor = private_file(path, os.O_RDONLY)
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        return handle.read(MAX_METADATA_BYTES)


class ArchiveStore:
    """Serialize quota accounting and cleanup across concurrent SSH workers."""

    def __init__(self, max_task_bytes, max_archive_bytes, root=None):
        self.max_task_bytes = max_task_bytes
        self.max_archive_bytes = max_archive_bytes
        base = root or os.path.join(os.path.expanduser("~"), ".neverssh")
        private_directory(base)
        self.root = os.path.join(base, "sessions")
        private_directory(self.root)
        self.guard_fd = private_file(os.path.join(base, ".archive.lock"), os.O_RDWR | os.O_CREAT)

    def cleanup_due(self, interval=3600):
        """Persist cleanup time so short-lived connections do not rescan every archive."""
        marker = os.path.join(os.path.dirname(self.root), ".cleanup")
        try:
            return time.time() - os.stat(marker).st_mtime >= interval
        except OSError:
            return True

    def mark_cleanup(self):
        """Record a completed cleanup without changing the shared quota counter."""
        marker = os.path.join(os.path.dirname(self.root), ".cleanup")
        descriptor = private_file(marker, os.O_WRONLY | os.O_CREAT)
        try:
            os.utime(descriptor, None)
        finally:
            os.close(descriptor)

    @contextmanager
    def guard(self):
        """Keep the accounting inode stable; it is never unlinked by cleanup."""
        fcntl.flock(self.guard_fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(self.guard_fd, fcntl.LOCK_UN)

    def session_path(self, connection_id):
        """Validate an internal identity before using it as a directory component."""
        if not CONNECTION_ID.fullmatch(connection_id):
            raise ArchiveError("ARCHIVE_UNAVAILABLE", "Invalid archive connection ID")
        return os.path.join(self.root, connection_id)

    def new_session(self, connection_id):
        """Claim a directory before publishing its connection ID; never reuse old archives."""
        directory = self.session_path(connection_id)
        with self.guard():
            try:
                os.mkdir(directory, 0o700)
            except FileExistsError:
                raise ArchiveError("SESSION_ID_EXISTS", "Connection archive already exists")
            descriptor = private_file(os.path.join(directory, ".session.lock"), os.O_RDWR | os.O_CREAT | os.O_EXCL)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            try:
                write_metadata(os.path.join(directory, "session.json"), {
                    "format": FORMAT, "connection_id": connection_id, "created_at": utc_timestamp(time.time()),
                })
            except Exception:
                os.close(descriptor)
                raise
            return descriptor

    def new_task(self, connection_id, task_id, command):
        """Create an output file exclusively while cleanup is excluded."""
        if not TASK_ID.fullmatch(task_id):
            raise ArchiveError("ARCHIVE_UNAVAILABLE", "Invalid archive task ID")
        directory = self.session_path(connection_id)
        if not stat.S_ISDIR(os.lstat(directory).st_mode):
            raise ArchiveError("ARCHIVE_UNAVAILABLE", "Session archive is unavailable")
        header = ("Command:\n" + command + "\n\nOutput:\n").encode("utf-8")
        with self.guard():
            self.require_capacity(len(header))
            prefix = os.path.join(directory, task_id)
            if os.path.lexists(prefix + ".meta.json"):
                raise ArchiveError("TASK_ID_EXISTS", "Task metadata already exists")
            try:
                lock = private_file(prefix + ".lock", os.O_RDWR | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                raise ArchiveError("TASK_ID_EXISTS", "Task archive already exists")
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                log = private_file(prefix + ".log", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            except Exception:
                os.close(lock)
                os.unlink(prefix + ".lock")
                if os.path.lexists(prefix + ".log"):
                    raise ArchiveError("TASK_ID_EXISTS", "Task output file already exists")
                raise
            return TaskArchive(self, prefix, log, lock, connection_id, task_id, command, header)

    def total_bytes(self):
        """Reconcile actual regular-log sizes while all archive writers are excluded."""
        total = 0
        for session in os.scandir(self.root):
            if not CONNECTION_ID.fullmatch(session.name) or not session.is_dir(follow_symlinks=False):
                continue
            for entry in os.scandir(session.path):
                if entry.name.endswith(".log") and TASK_ID.fullmatch(entry.name[:-4]) and entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
        return total

    def set_usage(self, value):
        """Store one fixed-width counter under the same lock used for log writes."""
        os.pwrite(self.guard_fd, struct.pack("!Q", value), 0)

    def usage(self):
        """Rebuild a missing counter after first use; connect/cleanup also reconciles crashes."""
        encoded = os.pread(self.guard_fd, 8, 0)
        if len(encoded) == 8:
            return struct.unpack("!Q", encoded)[0]
        value = self.total_bytes()
        self.set_usage(value)
        return value

    def require_capacity(self, minimum_bytes):
        """Reject new commands before executing them when retained logs fill the budget."""
        if minimum_bytes > self.max_task_bytes:
            raise ArchiveError("OUTPUT_LIMIT_REACHED", "Command record exceeds the per-task log budget; command was not started")
        if self.usage() + minimum_bytes > self.max_archive_bytes:
            raise ArchiveError("OUTPUT_LIMIT_REACHED", "Insufficient archive space to record the command; retained logs were not deleted")

    def cleanup(self, now=None):
        """Delete expired inactive tasks, then prune empty sessions without active workers."""
        now = time.time() if now is None else now
        with self.guard():
            for session in os.scandir(self.root):
                if not CONNECTION_ID.fullmatch(session.name) or not session.is_dir(follow_symlinks=False):
                    continue
                for entry in os.scandir(session.path):
                    if entry.name.endswith(".log") and TASK_ID.fullmatch(entry.name[:-4]) and entry.is_file(follow_symlinks=False):
                        self.cleanup_task(entry.path[:-4], now)
                    elif entry.name.startswith(".metadata-") and entry.is_file(follow_symlinks=False):
                        if now - entry.stat(follow_symlinks=False).st_mtime >= RETENTION_SECONDS:
                            os.unlink(entry.path)
                self.prune_session(session.path)
            self.set_usage(self.total_bytes())

    def cleanup_task(self, prefix, now):
        """An exclusive task lock proves that no helper is still writing this log."""
        descriptor = private_file(prefix + ".lock", os.O_RDWR | os.O_CREAT)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            modified = os.lstat(prefix + ".log").st_mtime
            expires = modified + RETENTION_SECONDS
            metadata_exists = os.path.exists(prefix + ".meta.json")
            try:
                metadata_fd = private_file(prefix + ".meta.json", os.O_RDONLY)
                with os.fdopen(metadata_fd, "r", encoding="utf-8") as handle:
                    metadata = json.loads(handle.read(MAX_METADATA_BYTES))
                if isinstance(metadata, dict) and metadata.get("format") not in (None, FORMAT):
                    # Do not delete archives written by a newer, unknown format.
                    return
                if isinstance(metadata, dict) and metadata.get("finished_at"):
                    expires = datetime.fromisoformat(metadata["finished_at"]).timestamp() + RETENTION_SECONDS
            except (OSError, ValueError, TypeError):
                if metadata_exists:
                    return
            if now < expires:
                return
            for extension in (".log", ".meta.json", ".lock"):
                try:
                    os.unlink(prefix + extension)
                except FileNotFoundError:
                    pass
        finally:
            os.close(descriptor)

    def prune_session(self, directory):
        """Never remove a session directory while a worker can still admit commands."""
        descriptor = private_file(os.path.join(directory, ".session.lock"), os.O_RDWR | os.O_CREAT)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            session_file = os.path.join(directory, "session.json")
            if os.path.exists(session_file):
                try:
                    metadata = json.loads(read_metadata(session_file))
                    if isinstance(metadata, dict) and metadata.get("format") not in (None, FORMAT):
                        return
                except (OSError, ValueError, TypeError):
                    return
            if set(os.listdir(directory)) <= {".session.lock", "session.json"}:
                for name in os.listdir(directory):
                    os.unlink(os.path.join(directory, name))
                os.rmdir(directory)
        finally:
            os.close(descriptor)

    def close(self):
        """Release this process's quota descriptor after all archive operations finish."""
        os.close(self.guard_fd)


class TaskArchive:
    """Hold the active lock until final metadata and all output bytes are written."""

    def __init__(self, store, prefix, log, lock, connection_id, task_id, command, header):
        self.store = store
        self.path = prefix + ".log"
        self.metadata_path = prefix + ".meta.json"
        self.log = log
        self.lock = lock
        self.bytes = 0
        self.output_offset = len(header)
        self.metadata = {"format": FORMAT, "connection_id": connection_id, "task_id": task_id,
                         "command": command, "output_offset": self.output_offset,
                         "started_at": utc_timestamp(time.time()), "output_bytes": 0,
                         "file_bytes": len(header)}
        try:
            # new_task holds the shared budget lock until the full command record is persisted.
            self.write_locked(header)
            write_metadata(self.metadata_path, self.metadata)
        except Exception:
            self.close()
            raise

    def append(self, data):
        """Reserve quota before writing; return the retained prefix on a size limit."""
        with self.store.guard():
            return self.write_locked(data)

    def write_locked(self, data):
        """Account for actual file bytes, including the command header, under the caller's lock."""
        used = self.store.usage()
        allowed = min(len(data), max(0, self.store.max_task_bytes - self.bytes),
                      max(0, self.store.max_archive_bytes - used))
        retained = data[:allowed]
        self.store.set_usage(used + allowed)
        written = 0
        try:
            while written < allowed:
                count = os.write(self.log, retained[written:])
                if count == 0:
                    raise OSError("Archive write made no progress")
                written += count
        finally:
            self.bytes += written
            if written < allowed:
                self.store.set_usage(used + written)
        return retained

    def finish(self, exit_code, reason, output_complete=None):
        """Set a fixed expiry; later reads do not extend the retention period."""
        finished = time.time()
        if output_complete is None:
            output_complete = reason not in ("output_limit", "output_error", "failed")
        self.metadata.update({"finished_at": utc_timestamp(finished),
                              "expires_at": utc_timestamp(finished + RETENTION_SECONDS),
                              "exit_code": exit_code, "reason": reason, "file_bytes": self.bytes,
                              "output_bytes": self.bytes - self.output_offset,
                              "output_complete": output_complete})
        try:
            write_metadata(self.metadata_path, self.metadata)
        finally:
            self.close()

    def close(self):
        """Release descriptors even if writing the final metadata failed."""
        os.close(self.log)
        os.close(self.lock)
