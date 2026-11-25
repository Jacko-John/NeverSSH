"""Lease resident Python helpers with fresh stdin, stdout and stderr pipes for each task."""
import array
from contextlib import ExitStack
import os
import socket
import subprocess
import sys


BOOTSTRAP = (
    "import socket,sys; sys.path.insert(0,sys.argv[1]); "
    "from helper import serve; serve(socket.socket(fileno=int(sys.argv[2])))"
)


class Helper:
    def __init__(self, build_dir):
        self.channel, remote = socket.socketpair()
        try:
            self.child = subprocess.Popen(
                [sys.executable, "-I", "-B", "-u", "-c", BOOTSTRAP, build_dir, str(remote.fileno())],
                pass_fds=(remote.fileno(),), start_new_session=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            )
        except BaseException:
            self.channel.close()
            raise
        finally:
            remote.close()

    def assign(self):
        with ExitStack() as local, ExitStack() as remote:
            descriptors = array.array("i")
            streams = []
            for mode in ("wb", "rb", "rb"):
                reader, writer = os.pipe()
                near, far = (writer, reader) if mode == "wb" else (reader, writer)
                remote.callback(os.close, far)
                descriptors.append(far)
                streams.append(local.enter_context(os.fdopen(near, mode, buffering=0)))
            self.channel.sendmsg([b"T"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
            local.pop_all()
            return TaskPipes(self, *streams)

    def close(self):
        self.channel.close()
        if self.child.poll() is None:
            self.child.terminate()
        try:
            self.child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()


class TaskPipes:
    """The task has its own EOF and status even when its interpreter serves another task."""
    def __init__(self, helper, stdin, stdout, stderr):
        self.helper = helper
        self.stdin, self.stdout, self.stderr = stdin, stdout, stderr
        self.returncode = None

    def poll(self):
        if self.returncode is None:
            try:
                status = self.helper.channel.recv(1, socket.MSG_DONTWAIT)
            except BlockingIOError:
                return None
            except ConnectionResetError:
                status = b""
            self.returncode = status[0] if status else 255
        return self.returncode

    def terminate(self):
        self.helper.child.terminate()

    def kill(self):
        self.helper.child.kill()


class HelperPool:
    """Grow only on admission. The worker's active-request limit bounds the pool."""
    def __init__(self, build_dir):
        self.build_dir = build_dir
        self.idle = []

    def acquire(self):
        while self.idle:
            helper = self.idle.pop()
            if helper.child.poll() is None:
                try:
                    return helper.assign()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException:
                    helper.close()
                    raise
            helper.close()
        helper = Helper(self.build_dir)
        try:
            return helper.assign()
        except BaseException:
            helper.close()
            raise

    def release(self, task, reusable):
        if reusable and task.returncode in (0, 2):
            self.idle.append(task.helper)
        else:
            task.helper.close()

    def close(self):
        for helper in self.idle:
            helper.close()
        self.idle.clear()
