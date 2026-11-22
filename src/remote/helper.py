"""Command helper: one noninteractive Bash process with its private archive.

The connection worker launches this source only for Bash requests. File operations
run inside the persistent worker and do not load this module.
"""
import base64
from collections import deque
import hashlib
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from neverssh_archive import ArchiveError, ArchiveStore


def emit(value):
    """Write one protocol record, failing immediately when the SSH peer is gone."""
    sys.stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
    sys.stdout.flush()


class OutputPreview:
    """Stream a short result. For longer output, retain only the undelivered tail."""

    LIMIT = 65536
    CHUNKS = 4096

    def __init__(self, header_bytes):
        self.stream_until = header_bytes + self.LIMIT
        self.pushes_left = self.CHUNKS
        self.delivered = self.reported = self.total = header_bytes
        self.next_report = 0.0
        self.chunks = deque()
        self.size = 0
        # Recreate each UTF-8 decoder at a gap, even if stderr and stdout interleave.
        self.before = {"stdout": b"", "stderr": b""}

    def remember(self, stream, data):
        self.before[stream] = data[-3:] if len(data) >= 3 else (self.before[stream] + data)[-3:]

    def append(self, stream, data, total):
        self.total = total
        if total <= self.stream_until and self.pushes_left:
            emit({"event": "output", "stream": stream, "base64": base64.b64encode(data).decode("ascii"),
                  "outputBytes": total})
            self.remember(stream, data)
            self.pushes_left -= 1
            self.delivered = self.reported = total
            return
        self.chunks.append((stream, data))
        self.size += len(data)
        while self.size > self.LIMIT or len(self.chunks) > self.CHUNKS:
            old_stream, old = self.chunks.popleft()
            self.size -= len(old)
            self.remember(old_stream, old)

    def report(self, now):
        if self.total > self.reported and now >= self.next_report:
            emit({"event": "progress", "outputBytes": self.total})
            self.reported = self.total
            self.next_report = now + 0.25

    def deliver(self, request_id=None):
        # One JSON line makes a snapshot atomic on disconnect. Signed lengths keep even
        # 4096 alternating one-byte writes within the helper's 128 KiB record budget.
        packet = {"event": "tail", "outputBytes": self.total,
                  "lengths": [len(data) if stream == "stdout" else -len(data) for stream, data in self.chunks],
                  "base64": base64.b64encode(b"".join(data for _, data in self.chunks)).decode("ascii")}
        if request_id is not None:
            packet["requestId"] = request_id
        if self.total - self.size > self.delivered:
            packet["before"] = {stream: base64.b64encode(seed).decode("ascii") for stream, seed in self.before.items()}
        emit(packet)
        for stream, data in self.chunks:
            self.remember(stream, data)
        self.chunks.clear()
        self.size = 0
        self.delivered = self.reported = self.total


def die_with_parent():
    """Ask Linux to terminate this process when its parent disappears; other systems ignore it."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def file_stamp(info):
    """A rename, rewrite, or truncation during the view invalidates the observation."""
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def view_stamp(path, limit):
    try:
        info = os.stat(path)
        if stat.S_ISREG(info.st_mode) and info.st_size <= limit:
            return file_stamp(info)
    except OSError:
        pass  # The command itself reports missing or unreadable operands.


def viewed_revision(path, stamp, requested_cwd):
    """Hash only the bounded regular file that stayed in place throughout the Bash view."""
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as handle:
            if file_stamp(os.fstat(handle.fileno())) != stamp:
                return None
            data = handle.read(stamp[2] + 1)
            canonical = os.path.realpath(path)
            if len(data) == stamp[2] and file_stamp(os.stat(canonical)) == stamp:
                # getcwd() resolves symlinked directories. Keep the caller's lexical alias
                # only while it still points to the same file (including paths with '..').
                request_path = os.path.normpath(os.path.join(requested_cwd, path))
                if os.path.realpath(request_path) != canonical:
                    request_path = canonical
                return {"path": canonical, "requestPath": request_path, "hasNul": b"\x00" in data,
                        "sha256": hashlib.sha256(data).hexdigest()}
    except OSError:
        pass  # Revision tracking is optional when a file disappears during the command.


def command_session(requested_cwd):
    """Run one noninteractive Bash with a private archive and an owned process group."""
    bash = shutil.which("bash")
    if bash is None:
        raise ArchiveError("BASH_UNAVAILABLE", "Bash is required on the remote host")
    store = ArchiveStore(request["maxTaskOutputBytes"], request["maxArchiveBytes"])
    archive = None
    preview = None
    child = None
    selector = selectors.DefaultSelector()
    reason = None
    message = None
    output_complete = True
    stop_requested = False
    stopping_at = None
    ended_at = None
    kill_sent = False
    controls = bytearray()

    def send_signal(signum):
        """Signal only the process group created for this command."""
        if child is None:
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    def stop(why):
        """Preserve the first stop reason and escalate after two seconds."""
        nonlocal stopping_at, reason
        if stopping_at is None:
            reason = why
            stopping_at = time.monotonic()
            send_signal(signal.SIGTERM)

    def interrupted(signum, frame):
        """The wakeup fd interrupts select. Reap or stop children in the event loop."""
        nonlocal stop_requested
        if signum != signal.SIGCHLD:
            stop_requested = True

    wake_reader, wake_writer = os.pipe()
    previous_fd = None
    previous = {}
    try:
        os.set_blocking(wake_reader, False)
        os.set_blocking(wake_writer, False)
        selector.register(wake_reader, selectors.EVENT_READ, "signal")
        previous_fd = signal.set_wakeup_fd(wake_writer, warn_on_full_buffer=False)
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGCHLD):
            previous[sig] = signal.signal(sig, interrupted)
        archive = store.new_task(request["connectionId"], args["taskId"], args["command"])
        preview = OutputPreview(archive.bytes)
        view_path = args.get("viewPath")
        stamp = view_stamp(view_path, request["maxFileBytes"]) if view_path else None
        # Shell configuration and environment changes belong only to this process.
        child = subprocess.Popen([bash, "--noprofile", "--norc", "-c", args["command"]],
                                 cwd=os.getcwd(), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, preexec_fn=die_with_parent)
        for pipe, stream in ((child.stdout, "stdout"), (child.stderr, "stderr")):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, stream)
        os.set_blocking(sys.stdin.fileno(), False)
        selector.register(sys.stdin, selectors.EVENT_READ, "control")
        emit({"event": "started", "pid": child.pid, "cwd": os.getcwd(),
              "outputFile": archive.path, "outputBytes": archive.bytes})
        while True:
            now = time.monotonic()
            preview.report(now)
            deadlines = [preview.next_report] if preview.total > preview.reported else []
            if stop_requested:
                stop("disconnected")
            status = child.poll()
            if stopping_at is not None and not kill_sent:
                if now >= stopping_at + 2:
                    send_signal(signal.SIGKILL)
                    kill_sent = True
                else:
                    deadlines.append(stopping_at + 2)
            if status is not None:
                if ended_at is None:
                    ended_at = now
                output_open = any(key.data in ("stdout", "stderr") for key in selector.get_map().values())
                if not output_open or now >= ended_at + 2.5:
                    break
                if now >= ended_at + 0.2 and not kill_sent:
                    send_signal(signal.SIGKILL)
                    kill_sent = True
                deadlines.append(ended_at + (2.5 if kill_sent else 0.2))

            timeout = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            for key, _ in selector.select(timeout):
                try:
                    chunk = os.read(key.fd, 16384)
                except BlockingIOError:
                    continue
                if key.data == "signal":
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    if key.data == "control":
                        stop("disconnected")
                    continue
                if key.data != "control":
                    if not output_complete:
                        continue
                    try:
                        retained = archive.append(chunk)
                    except OSError as error:
                        output_complete = False
                        message = "Cannot write command archive: " + str(error)
                        stop("output_error")
                        continue
                    if retained:
                        preview.append(key.data, retained, archive.bytes)
                    if len(retained) < len(chunk):
                        output_complete = False
                        message = "Command stopped at the configured output budget; the log contains a partial prefix"
                        stop("output_limit")
                    continue
                controls.extend(chunk)
                if len(controls) > 131072:
                    raise ValueError("Command control record exceeds the protocol limit")
                while b"\n" in controls:
                    record, _, remainder = controls.partition(b"\n")
                    controls = bytearray(remainder)
                    control = json.loads(record)
                    if control.get("action") == "stop":
                        stop("cancelled")
                    elif control.get("action") == "preview":
                        preview.deliver(control["requestId"])
                    else:
                        raise ValueError("Unsupported command control")
    except Exception:
        reason = reason or "failed"
        output_complete = False
        raise
    finally:
        cleanup_error = None
        if child is not None:
            try:
                if not kill_sent:
                    send_signal(signal.SIGKILL)
                child.wait()
            except OSError as error:
                # Darwin may reject signals to a group containing only zombies.
                # Preserve the failure without abandoning the archive's terminal record.
                cleanup_error = error
                reason = reason or "failed"
                output_complete = False
                child.poll()
            finally:
                child.stdout.close()
                child.stderr.close()
        selector.close()
        if archive is not None:
            try:
                archive.finish(child.returncode if child is not None else None, reason, output_complete)
            except OSError as error:
                reason = reason or "output_error"
                output_complete = False
                message = "Cannot finalize command archive: " + str(error)
                cleanup_error = cleanup_error or error
        store.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if previous_fd is not None:
            signal.set_wakeup_fd(previous_fd)
        os.close(wake_writer)
        os.close(wake_reader)
        if preview is not None and preview.total > preview.delivered:
            preview.deliver()
        if cleanup_error is not None:
            raise cleanup_error
    revision = None
    if stamp is not None and reason is None and child.returncode == 0:
        revision = viewed_revision(view_path, stamp, requested_cwd)
    emit({"event": "exit", "exitCode": child.returncode, "reason": reason, "viewedFile": revision,
          "message": message, "outputBytes": archive.bytes,
          "outputComplete": output_complete})


# The worker supplies one command request before starting this process.
request = payload["request"]
args = request.get("args", {})


try:
    die_with_parent()
    cwd = os.path.expanduser(request["cwd"])
    requested_cwd = os.path.abspath(cwd)
    os.chdir(cwd)
    command_session(requested_cwd)
except Exception as error:
    code = getattr(error, "code", type(error).__name__)
    emit({"ok": False, "error": {"code": code,
                                 "message": str(error)}})
    # Exit 2 tells the worker this explicit rejection happened before Bash existed.
    sys.exit(2 if code in ("TASK_ID_EXISTS", "BASH_UNAVAILABLE") else 1)
