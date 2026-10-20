"""Run file operations and supervise isolated Bash helpers for one SSH connection."""
import base64
from dataclasses import dataclass
import json
import os
import selectors
import signal
import subprocess
import sys
import threading
import time
import types
from typing import Dict, Optional


HELPER_BOOTSTRAP = (
    'import json,sys; payload=json.loads(sys.stdin.buffer.readline()); '
    'import types; archive=types.ModuleType("neverssh_archive"); '
    'exec(compile(open(payload["archivePath"],"rb").read(),payload["archivePath"],"exec"),archive.__dict__); '
    'sys.modules["neverssh_archive"]=archive; '
    'exec(compile(open(payload["sourcePath"],"rb").read(),payload["sourcePath"],"exec"))'
)

archive_module = types.ModuleType("neverssh_archive")
exec(compile(payload["archiveSource"], "<neverssh-archive>", "exec"), archive_module.__dict__)

file_ops_module = types.ModuleType("neverssh_file_ops")
exec(compile(payload["fileOpsSource"], "<neverssh-file-ops>", "exec"), file_ops_module.__dict__)


@dataclass
class ChildRequest:
    """Track a helper's pipes and cleanup deadline separately from the worker's connection state."""

    process: subprocess.Popen
    input_buffer: bytearray
    close_input: bool
    stdin_registered: bool = False
    open_output_streams: int = 2
    stopping_at: Optional[float] = None
    force_killed: bool = False

    def stop(self):
        """Let the helper clean up its command group before the worker escalates termination."""
        if self.stopping_at is None:
            self.stopping_at = time.monotonic()
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
        self.close_input = True


class FileRequest:
    """Run one short file request in a daemon thread while the worker keeps serving I/O."""

    def __init__(self, execute, request):
        self.execute = execute
        self.request = request
        self.done = False
        self.result = None
        self.error = None
        self.cancelled = False
        self.started_at = time.monotonic()
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        """Capture both result and exception so the event loop only performs protocol writes."""
        try:
            self.result = self.execute(self.request)
        except Exception as error:
            self.error = error
        finally:
            self.done = True

    def stop(self):
        """Abandon the response; short file I/O cannot be interrupted safely mid-syscall."""
        self.cancelled = True


class Worker:
    """Own the protocol stream, active helpers, and orderly shutdown for one connection."""

    def __init__(self, bootstrap_payload):
        self.max_file_bytes = bootstrap_payload["maxFileBytes"]
        self.connection_id = bootstrap_payload["connectionId"]
        self.build_dir = bootstrap_payload["buildDir"]
        self.build_id = bootstrap_payload["buildId"]
        self.server_version = bootstrap_payload["serverVersion"]
        self.protocol = bootstrap_payload["protocol"]
        self.archive_format = bootstrap_payload["archiveFormat"]
        self.archive_limits = {"maxTaskOutputBytes": bootstrap_payload["maxTaskOutputBytes"],
                               "maxArchiveBytes": bootstrap_payload["maxArchiveBytes"]}
        self.archive = None
        self.session_lock = None
        self.next_archive_cleanup = time.monotonic() + 3600
        self.selector = selectors.DefaultSelector()
        self.requests: Dict[str, ChildRequest] = {}
        self.incoming = bytearray()
        self.outgoing = bytearray()
        self.stopping = False
        self.stop_requested = False
        self.peer_gone = False
        self.bye_sent = False
        self.stdout_registered = False
        self.cleanup_confirmed = True
        self.wakeup_reader = None
        self.wakeup_writer = None

    def emit(self, message):
        """Queue bounded output so a blocked SSH peer cannot prevent child cleanup."""
        if self.peer_gone:
            return
        record = json.dumps(message, ensure_ascii=True).encode("utf-8") + b"\n"
        self.outgoing.extend(record)
        if len(self.outgoing) > self.max_file_bytes * 2 + 2097152:
            raise ValueError("Worker output backpressure limit exceeded")

    def interrupt(self, signum, frame):
        """Defer signal handling to the event loop, where all request state is available."""
        self.stop_requested = True

    def initialize(self):
        """Claim the session descriptors and report readiness before admitting requests."""
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, self.interrupt)
        os.set_blocking(sys.stdin.fileno(), False)
        os.set_blocking(sys.stdout.fileno(), False)
        self.selector.register(sys.stdin, selectors.EVENT_READ, (None, "control"))
        try:
            self.wakeup_reader, self.wakeup_writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        except AttributeError:
            self.wakeup_reader, self.wakeup_writer = os.pipe()
            os.set_blocking(self.wakeup_reader, False)
            os.set_blocking(self.wakeup_writer, False)
        self.selector.register(self.wakeup_reader, selectors.EVENT_READ, (None, "wakeup"))
        signal.set_wakeup_fd(self.wakeup_writer)

        if sys.version_info < (3, 8):
            self.emit({"type": "startup_error", "code": "RUNTIME_UNSUPPORTED",
                       "message": "Python 3.8 or newer is required"})
            self.stopping = True
            return
        os.chdir(os.path.expanduser("~"))
        try:
            self.archive = archive_module.ArchiveStore(self.archive_limits["maxTaskOutputBytes"],
                                                        self.archive_limits["maxArchiveBytes"])
            try:
                if self.archive.cleanup_due():
                    self.archive.cleanup()
                    self.archive.mark_cleanup()
            except Exception as error:
                print("NeverSSH archive cleanup failed: " + str(error), file=sys.stderr, flush=True)
            self.session_lock = self.archive.new_session(self.connection_id)
        except Exception as error:
            self.emit({"type": "startup_error", "code": getattr(error, "code", "ARCHIVE_UNAVAILABLE"),
                       "message": str(error)})
            self.stopping = True
            return
        self.emit({"type": "hello", "protocol": self.protocol, "version": self.server_version,
                   "build_id": self.build_id, "archive_format": self.archive_format,
                   "python_version": sys.version.split()[0], "home": os.path.expanduser("~")})

    def handle_message(self, message):
        """Separate connection controls from request creation and per-request input."""
        kind = message["type"]
        request_id = message.get("id")
        if kind == "shutdown":
            self.stopping = True
        elif kind == "request":
            self.start_request(request_id, message)
        elif kind in ("control", "eof", "cancel"):
            self.control_request(request_id, message)
        else:
            raise ValueError("Unknown worker message")

    def reject_request(self, request_id, diagnostic):
        """Report a failed admission without stopping unrelated active requests."""
        encoded = base64.b64encode(diagnostic.encode("utf-8")).decode("ascii")
        self.emit({"type": "stderr", "id": request_id, "base64": encoded})
        self.emit({"type": "close", "id": request_id, "code": 1})

    def start_request(self, request_id, message):
        """Admit file work into the persistent worker and keep Bash in an isolated helper."""
        if self.stopping or len(self.requests) >= 8 or request_id in self.requests:
            self.reject_request(request_id, "Worker is closing or full")
            return

        operation = message["op"]
        request_payload = {
            "op": operation,
            "cwd": message.get("cwd") or os.path.expanduser("~"),
            "maxFileBytes": self.max_file_bytes,
            "args": message.get("args", {}),
            "connectionId": self.connection_id,
            **self.archive_limits,
        }
        if operation in ("read", "write", "edit", "stat", "hash", "mkdir", "probe"):
            self.requests[request_id] = FileRequest(file_ops_module.dispatch, request_payload)
            return
        if operation != "bash":
            self.reject_request(request_id, "Unsupported operation")
            return

        try:
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-u", "-c", HELPER_BOOTSTRAP],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as error:
            self.reject_request(request_id, str(error))
            return

        request_payload = {
            "sourcePath": os.path.join(self.build_dir, "helper.py"),
            "archivePath": os.path.join(self.build_dir, "archive.py"),
            "request": request_payload,
        }
        data = json.dumps(request_payload, ensure_ascii=True).encode("utf-8") + b"\n"
        self.requests[request_id] = ChildRequest(process, bytearray(data), operation != "bash")
        for pipe, stream in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, (request_id, stream))
        os.set_blocking(process.stdin.fileno(), False)

    def control_request(self, request_id, message):
        """Forward command input, close stdin, or ask a helper to terminate its children."""
        request = self.requests.get(request_id)
        if request is None:
            return
        if isinstance(request, FileRequest):
            if message["type"] == "cancel":
                request.stop()
            return
        kind = message["type"]
        if kind == "cancel":
            request.stop()
        elif kind == "eof":
            request.close_input = True
        elif not request.close_input:
            request.input_buffer.extend(json.dumps(message["message"]).encode("utf-8") + b"\n")
            if len(request.input_buffer) > self.max_file_bytes * 2 + 131072:
                request.stop()

    def emit_file_response(self, request_id, request):
        """Chunk a file result so every worker protocol record stays below the client line limit."""
        if request.error is None:
            response = {"ok": True, "result": request.result}
        else:
            response = {"ok": False, "error": {
                "code": getattr(request.error, "code", type(request.error).__name__),
                "message": str(request.error),
            }}
        data = json.dumps(response, ensure_ascii=True).encode("utf-8") + b"\n"
        for offset in range(0, len(data), 16384):
            chunk = data[offset:offset + 16384]
            self.emit({"type": "stdout", "id": request_id,
                       "base64": base64.b64encode(chunk).decode("ascii")})

    def update_requests(self):
        """Escalate slow cleanup and retire helpers only after both output pipes are drained."""
        for request_id, request in list(self.requests.items()):
            if isinstance(request, FileRequest):
                if self.stopping and not request.done and time.monotonic() - request.started_at > 4:
                    self.emit({"type": "close", "id": request_id, "code": 255})
                    del self.requests[request_id]
                    continue
                if not request.done:
                    continue
                if not request.cancelled:
                    self.emit_file_response(request_id, request)
                self.emit({"type": "close", "id": request_id,
                           "code": 255 if request.cancelled else (1 if request.error is not None else 0)})
                del self.requests[request_id]
                continue

            if request.stopping_at is not None and not request.force_killed:
                if time.monotonic() - request.stopping_at > 4:
                    self.cleanup_confirmed = False
                    request.process.kill()
                    request.force_killed = True

            if request.open_output_streams == 0 and request.process.poll() is not None:
                if request.stdin_registered:
                    self.selector.unregister(request.process.stdin)
                request.process.stdin.close()
                self.emit({"type": "close", "id": request_id, "code": request.process.returncode})
                del self.requests[request_id]
                self.next_archive_cleanup = 0
            else:
                self.update_stdin(request_id, request)

    def update_stdin(self, request_id, request):
        """Watch writable stdin only while data is queued, then apply the requested EOF."""
        pipe = request.process.stdin
        if pipe.closed:
            return
        if request.input_buffer and not request.stdin_registered:
            self.selector.register(pipe, selectors.EVENT_WRITE, (request_id, "input"))
            request.stdin_registered = True
        elif not request.input_buffer and request.close_input:
            if request.stdin_registered:
                self.selector.unregister(pipe)
                request.stdin_registered = False
            pipe.close()

    def prepare_output(self):
        """Send one shutdown acknowledgement after requests finish, then flush pending output."""
        if self.stopping and not self.requests and not self.bye_sent:
            self.emit({"type": "bye", "cleanup_confirmed": self.cleanup_confirmed})
            self.bye_sent = True
        if self.outgoing and not self.stdout_registered:
            self.selector.register(sys.stdout, selectors.EVENT_WRITE, (None, "output"))
            self.stdout_registered = True

    def cleanup_archives(self):
        """Reclaim expired logs after requests and once an hour while connected."""
        if self.archive is None or time.monotonic() < self.next_archive_cleanup:
            return
        self.next_archive_cleanup = time.monotonic() + 3600
        try:
            if self.archive.cleanup_due():
                self.archive.cleanup()
                self.archive.mark_cleanup()
        except Exception as error:
            print("NeverSSH archive cleanup failed: " + str(error), file=sys.stderr, flush=True)

    def flush_output(self, descriptor):
        """Make bounded progress on the shared protocol stream without blocking the loop."""
        try:
            written = os.write(descriptor, self.outgoing[:65536])
            del self.outgoing[:written]
        except BlockingIOError:
            return
        except BrokenPipeError:
            self.outgoing.clear()
            self.peer_gone = True
            self.stopping = True
        if not self.outgoing:
            self.selector.unregister(sys.stdout)
            self.stdout_registered = False

    def flush_input(self, key, request_id):
        """Flush a helper's pending input, preserving backpressure and broken-pipe handling."""
        request = self.requests.get(request_id)
        if request is None:
            return
        try:
            written = os.write(key.fd, request.input_buffer[:65536])
            del request.input_buffer[:written]
        except BlockingIOError:
            return
        except BrokenPipeError:
            request.input_buffer.clear()
            request.close_input = True
        if not request.input_buffer:
            self.selector.unregister(key.fileobj)
            request.stdin_registered = False

    def receive_control(self, chunk):
        """Read complete client records before applying the unfinished-record size limit."""
        self.incoming.extend(chunk)
        while b"\n" in self.incoming:
            record, _, remainder = self.incoming.partition(b"\n")
            self.incoming = bytearray(remainder)
            self.handle_message(json.loads(record))
        if len(self.incoming) > self.max_file_bytes * 2 + 131072:
            raise ValueError("Worker request exceeds its size limit")

    def read_stream(self, key, request_id, stream):
        """Route client input or child output, treating client EOF as connection shutdown."""
        try:
            chunk = os.read(key.fd, 16384)
        except BlockingIOError:
            return
        if not chunk:
            self.selector.unregister(key.fileobj)
            if stream == "control":
                self.stopping = True
            else:
                self.requests[request_id].open_output_streams -= 1
                key.fileobj.close()
            return
        if stream == "control":
            self.receive_control(chunk)
        else:
            self.emit({"type": stream, "id": request_id,
                       "base64": base64.b64encode(chunk).decode("ascii")})

    def dispatch_io(self, key):
        """Keep descriptor routing separate from each stream's read/write behavior."""
        request_id, stream = key.data
        if stream == "output":
            self.flush_output(key.fd)
        elif stream == "input":
            self.flush_input(key, request_id)
        elif stream == "wakeup":
            try:
                os.read(key.fd, 4096)
            except BlockingIOError:
                pass
        else:
            self.read_stream(key, request_id, stream)

    def cleanup(self):
        """Reap owned helpers after normal exit, malformed input, or a broken peer."""
        for request in self.requests.values():
            request.stop()
        children = [request for request in self.requests.values() if isinstance(request, ChildRequest)]
        deadline = time.monotonic() + 4
        while any(request.process.poll() is None for request in children):
            if time.monotonic() >= deadline:
                break
            # A helper blocked on output still needs to run its own child-group cleanup.
            for request in children:
                for pipe in (request.process.stdout, request.process.stderr):
                    if not pipe.closed:
                        try:
                            os.read(pipe.fileno(), 65536)
                        except (BlockingIOError, OSError):
                            pass
            time.sleep(0.02)
        for request in children:
            process = request.process
            if process.poll() is None:
                process.kill()
            process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()
        try:
            signal.set_wakeup_fd(-1)
        except (ValueError, OSError):
            pass
        if self.wakeup_reader is not None:
            try:
                self.selector.unregister(self.wakeup_reader)
            except Exception:
                pass
            os.close(self.wakeup_reader)
            os.close(self.wakeup_writer)
        self.selector.close()
        if self.session_lock is not None:
            os.close(self.session_lock)
        if self.archive is not None:
            self.cleanup_archives()
            self.archive.close()

    def run(self):
        """Advance cleanup and I/O until the final acknowledgement has left the connection."""
        try:
            self.initialize()
            while True:
                if self.stop_requested:
                    self.stopping = True
                if self.stopping:
                    for request in self.requests.values():
                        request.stop()
                self.update_requests()
                self.cleanup_archives()
                self.prepare_output()
                if self.bye_sent and not self.outgoing:
                    break
                if self.requests or self.outgoing or self.stopping:
                    timeout = 0.05
                else:
                    timeout = min(60, max(0.05, self.next_archive_cleanup - time.monotonic()))
                for key, _ in self.selector.select(timeout):
                    self.dispatch_io(key)
        finally:
            self.cleanup()


# The SSH bootstrap supplies payload once; no service or import-time installation is needed.
Worker(payload).run()
