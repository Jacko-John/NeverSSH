"""File operations executed inside the persistent worker using only the standard library."""
import base64
import errno
import hashlib
import itertools
import os
import re
import shutil
import stat
import sys
import tempfile
import threading

import read_formats


# Fixed lock striping bounds memory while aliases of one canonical path share admission.
PATH_LOCKS = tuple(threading.Lock() for _ in range(64))
# Match str.splitlines(), including CRLF as a single line boundary.
LINE_BREAKS = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029"
LINE_BOUNDARY = re.compile("\r\n|[" + LINE_BREAKS + "]")


def mutation_lock(filename):
    """Serialize this worker's checks and commits for one already canonicalized path."""
    return PATH_LOCKS[hash(filename) % len(PATH_LOCKS)]


def path_for(value, cwd):
    """Resolve a remote path against the request working directory, including ~/ paths."""
    return os.path.abspath(os.path.join(cwd, os.path.expanduser(value)))


def load_bytes(filename, limit, follow_symlinks=True):
    """Read one bounded regular file; refuse devices, FIFOs, and files that grow past the limit."""
    flags = os.O_RDONLY | os.O_NONBLOCK
    if not follow_symlinks:
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(filename, flags)
    except OSError as error:
        if not follow_symlinks and error.errno == errno.ELOOP:
            raise ValueError("Expected a regular file, not a symlink") from None
        raise
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Expected a regular file")
        if info.st_size > limit:
            raise ValueError("File exceeds maxFileBytes; inspect or convert it on the remote host with ssh_bash")
        data = handle.read(limit + 1)
        if len(data) > limit:
            raise ValueError("File grew beyond maxFileBytes")
    return data, info


def digest(data):
    """Return the content revision used for optimistic edit checks."""
    return hashlib.sha256(data).hexdigest()


def text_from(data, lossy=False):
    """Allow replacement characters for display while keeping exact edits UTF-8 only."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        if lossy:
            return data.decode("utf-16", errors="replace")
        raise ValueError("Cannot edit UTF-16 text. Use ssh_write_file with clean UTF-8 text "
                         "or convert its encoding with ssh_bash.")
    if b"\x00" in data:
        raise ValueError("Binary file: inspect it with a format-specific tool or replace it with ssh_upload")
    try:
        return data.decode("utf-8", errors="replace" if lossy else "strict")
    except UnicodeDecodeError:
        raise ValueError("Cannot edit non-UTF-8 text. Read it with ssh_read_file and supply clean UTF-8 "
                         "content to ssh_write_file, or convert its encoding with ssh_bash.") from None


def line_spans(text):
    """Yield start, body end and end offsets without allocating a list for the whole file."""
    start = 0
    for match in LINE_BOUNDARY.finditer(text):
        yield start, match.start(), match.end()
        start = match.end()
    if start < len(text):
        yield start, len(text), len(text)


def line_count(text):
    """Count line boundaries in native string scans, also accounting for an unterminated tail."""
    breaks = sum(text.count(character) for character in LINE_BREAKS) - text.count("\r\n")
    return breaks + int(bool(text) and text[-1] not in LINE_BREAKS)


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

    Callers hold the canonical path's mutation lock across their read and this
    commit. The final recheck also detects changes by unrelated writers, without
    promising a filesystem transaction against other processes.
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
    """Return a view of one bounded file snapshot with its exact revision."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    data, _ = load_bytes(filename, request["maxFileBytes"])
    # Workspace validation follows symlinks; the user's filename can still identify the format.
    requested = args.get("requestedPath", args["path"])
    suffix = os.path.splitext(requested)[1].lower()
    if suffix not in (".ipynb", ".pdf"):
        suffix = os.path.splitext(filename)[1].lower()
    if "pages" in args and suffix != ".pdf":
        raise ValueError("The pages parameter is for PDF files; use offset and limit for text")
    mime_type = read_formats.image_mime_type(data)
    if mime_type is not None:
        return {"kind": "image", "mimeType": mime_type,
                "base64": base64.b64encode(data).decode("ascii"),
                "path": filename, "size": len(data), "sha256": digest(data)}
    if suffix in (".ipynb", ".pdf"):
        if suffix == ".ipynb":
            result = read_formats.read_notebook(data, request["maxFileBytes"])
        else:
            result = read_formats.read_pdf(data, request)
        result.update(path=filename, size=len(data), sha256=digest(data))
        return result
    extension = read_formats.binary_extension(requested) or read_formats.binary_extension(filename)
    if extension:
        raise ValueError("Binary file (%s): use a format-specific skill or inspect it with an appropriate "
                         "reader through ssh_bash" % extension)
    start = args.get("startLine", 1) - 1
    count = args.get("lineCount", 2000)
    oversized = start == 0 and len(data) > read_formats.TEXT_READ_BYTES
    paging_hint = ("Whole-file read exceeds 256 KiB. Read a smaller range with offset and limit "
                   "or search with rg through ssh_bash.")
    if oversized and "lineCount" not in args:
        raise ValueError(paging_hint)
    text = text_from(data, lossy=True)
    total = line_count(text)
    if oversized and count >= total:
        raise ValueError(paging_hint)
    first = last = len(text)
    end = min(start, total)
    remaining = args.get("maxBytes", read_formats.TEXT_READ_BYTES)
    for left, _, right in itertools.islice(line_spans(text), end, min(start + count, total)):
        # A UTF-8 character occupies at least one byte. Avoid copying very long lines just to reject them.
        size = right - left
        if size <= remaining and not text.isascii():
            size = len(text[left:right].encode("utf-8"))
        if size > remaining:
            if end == start:
                raise ValueError("Line exceeds the read byte budget; read a narrower range or download the file")
            break
        first = min(first, left)
        last = right
        end += 1
        remaining -= size
    return {"path": filename, "content": text[first:last], "startLine": start + 1,
            "endLine": end, "totalLines": total, "truncated": end < total,
            "nextLine": end + 1 if end < total else None,
            "size": len(data), "sha256": digest(data)}


def write_file(request):
    """Create or explicitly overwrite a regular file, following its final symlink."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    with mutation_lock(filename):
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
                binary = read_formats.binary_extension(filename) or b"\x00" in current
                readable_media = (read_formats.image_mime_type(current) or current.startswith((b"\xff\xfe", b"\xfe\xff"))
                                  or filename.lower().endswith(".pdf"))
                if binary and not readable_media:
                    raise ValueError("Binary file: use ssh_upload with overwrite=true to replace it, "
                                     "or use a format-specific command through ssh_bash.")
                raise ValueError("File exists: read it with ssh_read_file first, through the last page. "
                                 "For a file the reader cannot open, use ssh_upload with overwrite=true to replace it.")
            if digest(current) != expected:
                raise ValueError("Content conflict: file changed since it was read; read it again")
        data = base64.b64decode(args["base64"], validate=True)
        if original is not None and b"\xef\xbf\xbd" in data:
            try:
                current.decode("utf-8")
            except UnicodeDecodeError:
                raise ValueError("Cannot overwrite non-UTF-8 text with U+FFFD replacement characters. "
                                 "Supply clean UTF-8 text or convert the original encoding with ssh_bash.") from None
        result = atomic_write(filename, data, original, expected, limit)
        result["created"] = original is None
        return result


def edit_preview(content, match, old, new):
    """Show the first replacement in the committed text, with two nearby lines on each side."""
    # A caller may include substantial unchanged text to make the match unique.
    prefix = 0
    common = min(len(old), len(new))
    while prefix < common and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < common - prefix and old[-1 - suffix] == new[-1 - suffix]:
        suffix += 1
    start = match + prefix
    end = start + max(1, len(new) - prefix - suffix)

    before = []
    preview = []
    following = 0
    for number, (offset, body_end, line_end) in enumerate(line_spans(content), 1):
        column = max(0, start - offset) if offset <= start < line_end else 0
        left = max(0, column - 100)
        right = min(offset + left + 512, body_end)
        excerpt = ("…" if left else "") + content[offset + left:right] + ("…" if right < body_end else "")
        entry = {"line": number, "text": excerpt}
        if line_end <= start:
            before = (before + [entry])[-2:]
        else:
            if offset >= end:
                following += 1
            if following > 2:
                break
            if len(preview) == 12:
                return {"lines": before + preview, "truncated": True}
            preview.append(entry)
    return {"lines": before + preview, "truncated": False}


def edit_file(request):
    """Apply one exact replacement, mirroring Claude Code's Edit semantics."""
    args = request.get("args", {})
    old, new = args["oldText"], args["newText"]
    if old == new:
        raise ValueError("No changes to make: old_string and new_string are exactly the same.")
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    with mutation_lock(filename):
        data, info = load_bytes(filename, request["maxFileBytes"])
        revision = digest(data)
        if args.get("expectedSha256", revision) != revision:
            raise ValueError("Content conflict: file changed since it was read; read it again before editing")
        content = text_from(data)
        if not old:
            raise ValueError("oldText must not be empty")
        found = content.count(old)
        if args.get("replaceAll", False):
            if found == 0:
                raise ValueError("oldText not found; file was not changed")
        else:
            if found != 1:
                raise ValueError("Expected exactly one occurrence of oldText, found %d; file was not changed" % found)
        limit = request["maxFileBytes"]
        if len(data) + found * (len(new.encode("utf-8")) - len(old.encode("utf-8"))) > limit:
            raise ValueError("Content exceeds maxFileBytes")
        updated = content.replace(old, new)
        preview = edit_preview(updated, content.index(old), old, new)
        result = atomic_write(filename, updated.encode("utf-8"), info, revision, limit)
        result.update(preview=preview, replacements=found)
        return result


def commit_upload(request):
    """Verify staged SFTP bytes, then check and commit under the text writers' path lock."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
    temporary = path_for(args["temporary"], request["cwd"])
    try:
        with mutation_lock(filename):
            # Verify before changing the destination; a failed transfer never becomes visible.
            data, _ = load_bytes(temporary, request["maxFileBytes"], follow_symlinks=False)
            revision = digest(data)
            if revision != args["sha256"]:
                raise ValueError("Upload size or SHA-256 verification failed")
            expected = args.get("expectedSha256")
            try:
                destination = os.lstat(filename)
            except FileNotFoundError:
                destination = None
            if destination is not None and not stat.S_ISREG(destination.st_mode):
                raise ValueError("Upload destination must be a regular file")
            if expected is not None:
                try:
                    current, _ = load_bytes(filename, request["maxFileBytes"])
                except FileNotFoundError:
                    raise ValueError("Content conflict: expected file does not exist") from None
                if digest(current) != expected:
                    raise ValueError("Content conflict: SHA-256 does not match")

            # No-overwrite must remain atomic even when an unrelated process creates the file.
            if expected is None and not args.get("overwrite", False):
                os.link(temporary, filename)
                os.unlink(temporary)
            else:
                os.replace(temporary, filename)
            fsync_directory(os.path.dirname(filename))
            return {"path": filename, "bytesWritten": len(data), "sha256": revision}
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def stat_file(request):
    """Pin one canonical regular-file target for transfer checks, including missing files."""
    args = request.get("args", {})
    filename = path_for(args["path"], request["cwd"])
    canonical = os.path.realpath(filename)
    try:
        info = os.stat(canonical)
    except FileNotFoundError:
        return {"path": filename, "exists": False, "realpath": canonical}
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Expected a regular file")
    return {"path": filename, "exists": True, "size": info.st_size,
            "realpath": canonical}


def hash_file(request):
    """Hash an existing remote file without transferring its contents."""
    args = request.get("args", {})
    filename = os.path.realpath(path_for(args["path"], request["cwd"]))
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
    if operation == "commit_upload":
        return commit_upload(request)
    if operation == "stat":
        return stat_file(request)
    if operation == "hash":
        return hash_file(request)
    if operation == "mkdir":
        return make_directory(request)
    if operation == "probe":
        return probe(request)
    raise ValueError("Unsupported file operation: " + operation)
