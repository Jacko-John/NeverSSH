"""Command helper: one noninteractive Bash process with its private archive.

The connection worker launches this source only for Bash requests. File operations
run inside the persistent worker and do not load this module.
"""
import base64
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time
from neverssh_archive import ArchiveError, ArchiveStore


def emit(value):
    """Write one protocol record, failing immediately when the SSH peer is gone."""
    sys.stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def die_with_parent():
    """Ask Linux to terminate this process when its parent disappears; other systems ignore it."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def command_session():
    """Run one noninteractive Bash with a private archive and an owned process group."""
    bash = shutil.which("bash")
    if bash is None:
        raise ArchiveError("BASH_UNAVAILABLE", "Bash is required on the remote host")
    store = ArchiveStore(request["maxTaskOutputBytes"], request["maxArchiveBytes"])
    archive = None
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
        """Defer process operations until the child has finished starting."""
        nonlocal stop_requested
        stop_requested = True

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        archive = store.new_task(request["connectionId"], args["taskId"], args["command"])
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
            if stop_requested:
                stop("disconnected")
            status = child.poll()
            if stopping_at is not None and now - stopping_at >= 2 and not kill_sent:
                send_signal(signal.SIGKILL)
                kill_sent = True
            if status is not None:
                if ended_at is None:
                    ended_at = now
                output_open = any(key.data in ("stdout", "stderr") for key in selector.get_map().values())
                if not output_open or now - ended_at > 2.5:
                    break
                if now - ended_at > 0.2 and not kill_sent:
                    send_signal(signal.SIGKILL)
                    kill_sent = True

            for key, _ in selector.select(0.05):
                try:
                    chunk = os.read(key.fd, 16384)
                except BlockingIOError:
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
                        emit({"event": "output", "stream": key.data,
                              "base64": base64.b64encode(retained).decode("ascii"),
                              "outputBytes": archive.bytes})
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
                    if control.get("action") != "stop":
                        raise ValueError("Unsupported command control")
                    stop("cancelled")
    except Exception:
        reason = reason or "failed"
        output_complete = False
        raise
    finally:
        if child is not None:
            if not kill_sent:
                send_signal(signal.SIGKILL)
            child.wait()
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
        store.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    emit({"event": "exit", "exitCode": child.returncode, "reason": reason,
          "message": message, "outputBytes": archive.bytes,
          "outputComplete": output_complete})


# The worker supplies one command request before starting this process.
request = payload["request"]
args = request.get("args", {})


try:
    die_with_parent()
    os.chdir(os.path.expanduser(request["cwd"]))
    command_session()
except Exception as error:
    emit({"ok": False, "error": {"code": getattr(error, "code", type(error).__name__),
                                 "message": str(error)}})
    sys.exit(1)
