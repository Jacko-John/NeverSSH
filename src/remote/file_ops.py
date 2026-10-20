"""File operations executed inside the persistent worker using only the standard library."""
import base64
import hashlib
import os
import shutil
import stat
import sys
import tempfile


def path_for(value, cwd):
    """Resolve a remote path against the request working directory, including ~/ paths."""
    return os.path.abspath(os.path.join(cwd, os.path.expanduser(value)))


def load_bytes(filename, limit):
    """Read one bounded regular file; refuse devices, FIFOs, and files that grow past the limit."""
    descriptor = os.open(filename, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Expected a regular file")
        if info.st_size > limit:
            raise ValueError("File exceeds maxFileBytes; use an explicit SSH transfer for larger files")
        data = handle.read(limit + 1)
        if len(data) > limit:
            raise ValueError("File grew beyond maxFileBytes")
    return data, info


def digest(data):
    """Return the content revision used for optimistic edit checks."""
    return hashlib.sha256(data).hexdigest()


def text_from(data):
    """Require UTF-8 text for editing; binary data travels through the transfer tools."""
    if b"\x00" in data:
        raise ValueError("Binary file: use download instead of text tools")
    return data.decode("utf-8")


def fsync_directory(path):
    """Persist a rename or create in the parent directory; ignore filesystems without support."""
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_CLOEXEC)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_write(filename, data, original, expected, limit):
    """Replace content in the same directory, preserving Unix mode and ownership.

    Recheck the content just before rename. This detects stale reads but is not a
    filesystem transaction against unrelated writers racing the final rename.
    """
    if len(data) > limit:
        raise ValueError("Content exceeds maxFileBytes")
    os.makedirs(os.path.dirname(filename), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".neverssh-", dir=os.path.dirname(filename))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            if original is not None:
                os.fchown(handle.fileno(), original.st_uid, original.st_gid)
            os.fchmod(handle.fileno(), stat.S_IMODE(original.st_mode) if original else 0o644)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())

        # Fail before replacing the destination if another writer changed its content.
        if expected is not None:
            current, _ = load_bytes(filename, limit)
            if digest(current) != expected:
                raise ValueError("Content conflict: file changed; read it again before editing")
            os.replace(temporary, filename)
        else:
            # Linking is an atomic create-if-absent, including concurrent creators.
            os.link(temporary, filename)
            os.unlink(temporary)
        fsync_directory(os.path.dirname(filename))
        return {"path": filename, "bytesWritten": len(data), "sha256": digest(data)}
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_file(request):
    """Return complete UTF-8 lines within a byte budget, plus the full-file revision."""
    args = request.get("args", {})
    filename = path_for(args["path"], request["cwd"])
    data, _ = load_bytes(filename, request["maxFileBytes"])
    lines = text_from(data).splitlines(keepends=True)
    start = args.get("startLine", 1) - 1
    selected = []
    used = 0
    for line in lines[start:start + args.get("lineCount", 2000)]:
        size = len(line.encode("utf-8"))
        if used + size > args.get("maxBytes", 262144):
            if not selected:
                raise ValueError("Line exceeds the read byte budget; read a narrower range or download the file")
            break
        selected.append(line)
        used += size
    end = min(start, len(lines)) + len(selected)
    return {"path": filename, "content": "".join(selected), "startLine": start + 1,
            "endLine": end, "totalLines": len(lines), "truncated": end < len(lines),
            "nextLine": end + 1 if end < len(lines) else None,
            "size": len(data), "sha256": digest(data)}


def write_file(request):
    """Create or explicitly overwrite a regular file, following its final symlink."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    limit = request["maxFileBytes"]
    original = None
    expected = args.get("expectedSha256")
    try:
        current, original = load_bytes(filename, limit)
    except FileNotFoundError:
        if expected is not None:
            raise ValueError("Content conflict: expected file does not exist")
    if original is not None:
        if expected is None:
            raise ValueError("File exists: read it with ssh_read_file first")
        if digest(current) != expected:
            raise ValueError("Content conflict: file changed since it was read; read it again")
        expected = digest(current)
    data = (base64.b64decode(args["base64"], validate=True) if "base64" in args
            else args["content"].encode("utf-8"))
    result = atomic_write(filename, data, original, expected, limit)
    result["created"] = original is None
    return result


def edit_file(request):
    """Apply one exact replacement, mirroring Claude Code's Edit semantics."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    data, info = load_bytes(filename, request["maxFileBytes"])
    revision = digest(data)
    if args.get("expectedSha256", revision) != revision:
        raise ValueError("Content conflict: file changed since it was read; read it again before editing")
    content = text_from(data)
    old = args["oldText"]
    if not old:
        raise ValueError("oldText must not be empty")
    found = content.count(old)
    if args.get("replaceAll", False):
        if found == 0:
            raise ValueError("oldText not found; file was not changed")
        content = content.replace(old, args["newText"])
    else:
        if found != 1:
            raise ValueError("Expected exactly one occurrence of oldText, found %d; file was not changed" % found)
        content = content.replace(old, args["newText"], 1)
    return atomic_write(filename, content.encode("utf-8"), info, revision, request["maxFileBytes"])


def stat_file(request):
    """Report existence and metadata for upload conflict checks."""
    args = request.get("args", {})
    filename = path_for(args["path"], request["cwd"])
    try:
        info = os.stat(filename)
    except FileNotFoundError:
        return {"path": filename, "exists": False}
    return {"path": filename, "exists": True, "size": info.st_size,
            "realpath": os.path.realpath(filename)}


def hash_file(request):
    """Hash an existing remote file without transferring its contents."""
    args = request.get("args", {})
    filename = path_for(args["path"], request["cwd"])
    data, _ = load_bytes(filename, request["maxFileBytes"])
    return {"path": filename, "size": len(data), "sha256": digest(data)}


def make_directory(request):
    """Create missing remote parents for an SFTP upload."""
    args = request.get("args", {})
    filename = path_for(args["path"], request["cwd"])
    os.makedirs(filename, exist_ok=True)
    return {"path": filename}


def home_filesystem(home):
    """Read the Linux mount type for HOME; archive locks assume a local filesystem."""
    if not sys.platform.startswith("linux"):
        return None
    best = None
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) < 3:
                    continue
                mount = fields[1].replace("\\040", " ")
                if home == mount or home.startswith(mount.rstrip("/") + "/"):
                    if best is None or len(mount) > len(best[0]):
                        best = (mount, fields[2])
    except OSError:
        return None
    return best[1] if best else None


def probe(request):
    """Report the runtime details used by the local doctor command."""
    home = os.path.expanduser("~")
    return {"hostname": os.uname().nodename, "platform": sys.platform,
            "pythonVersion": sys.version.split()[0], "cwd": request["cwd"],
            "home": home, "user": __import__("getpass").getuser(),
            "bash": shutil.which("bash"), "filesystem": home_filesystem(home),
            "ripgrep": shutil.which("rg") is not None}


def dispatch(request):
    """Dispatch one validated file request; exceptions are returned as protocol errors."""
    operation = request["op"]
    if operation == "read":
        return read_file(request)
    if operation == "write":
        return write_file(request)
    if operation == "edit":
        return edit_file(request)
    if operation == "stat":
        return stat_file(request)
    if operation == "hash":
        return hash_file(request)
    if operation == "mkdir":
        return make_directory(request)
    if operation == "probe":
        return probe(request)
    raise ValueError("Unsupported file operation: " + operation)
