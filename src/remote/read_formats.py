"""Read Jupyter outputs and render PDF snapshots for ssh_read_file."""
import base64
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time


TEXT_READ_BYTES = 256 * 1024
PDF_WHOLE_PAGES = 10
PDF_RANGE_PAGES = 20
BINARY_EXTENSIONS = frozenset("""
    .7z .a .aac .apk .arrow .avi .avif .bin .bmp .bz2 .class .db .dll .dmg
    .doc .docm .docx .dylib .eot .epub .exe .feather .flac .gz .h5 .hdf5 .heic .heif .ico .jar
    .m4a .mkv .mov .mp3 .mp4 .npy .npz .o .ods .odt .ogg .otf .parquet
    .pkl .ppt .pptm .pptx .psd .pyc .rar .safetensors .so .sqlite .sqlite3 .tar .tgz .tif .tiff .ttf
    .wasm .wav .webm .woff .woff2 .xls .xlsm .xlsx .xz .zip .zst
""".split())


def binary_extension(filename):
    """Return a known binary extension, or an empty string for unclassified paths."""
    extension = os.path.splitext(filename)[1].lower()
    return extension if extension in BINARY_EXTENSIONS else ""


def document_budget(max_file_bytes):
    """Leave room for page labels, revision metadata and envelopes on both transports."""
    return min(9 * 1024 * 1024, max_file_bytes * 6 + 131072) - 8192


def image_mime_type(data):
    """Recognize supported raster encodings from their bytes."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def notebook_text(value):
    """Jupyter represents multiline strings either as one string or a list of fragments."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(part, str) for part in value):
        return "".join(value)
    raise ValueError("Invalid notebook: expected a string or list of strings")


def display_output(bundle):
    """Choose the richest supported representation of one MIME bundle without executing it."""
    if not isinstance(bundle, dict):
        raise ValueError("Invalid notebook display data")
    for mime in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        if mime in bundle:
            encoded = "".join(notebook_text(bundle[mime]).split())
            if image_mime_type(base64.b64decode(encoded, validate=True)) != mime:
                raise ValueError("Invalid notebook image for " + mime)
            return {"type": "image", "mimeType": mime, "data": encoded}
    for mime in ("image/svg+xml", "text/markdown", "text/plain", "text/html", "text/latex"):
        if mime in bundle:
            return {"type": "text", "text": notebook_text(bundle[mime])}
    for mime, value in bundle.items():
        if mime == "application/json" or mime.endswith("+json"):
            return {"type": "text", "text": json.dumps(value, ensure_ascii=False)}
    return {"type": "text", "text": "Unsupported notebook display format: " + ", ".join(bundle)}


def notebook_blocks(cells):
    """Yield cell source and saved outputs in notebook order."""
    for index, cell in enumerate(cells, 1):
        if not isinstance(cell, dict) or not isinstance(cell.get("outputs", []), list):
            raise ValueError("Invalid notebook cell %d" % index)
        source = notebook_text(cell.get("source", ""))
        yield {"type": "text", "text": "Cell %d (%s)\n%s" % (index, cell["cell_type"], source)}
        for output in cell.get("outputs", []):
            kind = output["output_type"]
            if kind in ("display_data", "execute_result", "update_display_data"):
                yield display_output(output["data"])
            elif kind == "stream":
                yield {"type": "text", "text": "%s:\n%s" % (output["name"], notebook_text(output["text"]))}
            elif kind == "error":
                trace = output.get("traceback", [])
                message = "\n".join(trace) if trace else "%s: %s" % (output["ename"], output.get("evalue", ""))
                yield {"type": "text", "text": message}
            else:
                yield {"type": "text", "text": "Unsupported notebook output: " + str(kind)}


def read_notebook(data, max_file_bytes):
    """Read all cells atomically, with separate limits for text and the mixed-media result."""
    notebook = json.loads(data.decode("utf-8-sig"))
    if not isinstance(notebook, dict) or not isinstance(notebook.get("cells"), list):
        raise ValueError("Invalid Jupyter notebook: expected a cells array")
    blocks = []
    text_size = 0
    remaining = document_budget(max_file_bytes)
    try:
        for block in notebook_blocks(notebook["cells"]):
            if block["type"] == "text":
                text_size += len(block["text"].encode("utf-8"))
                if text_size > TEXT_READ_BYTES:
                    raise ValueError("Notebook text exceeds 256 KiB. Use ssh_bash with jq to inspect selected cells.")
            remaining -= len(json.dumps(block, ensure_ascii=False).encode("utf-8")) + 2
            if remaining < 0:
                raise ValueError("Notebook exceeds the document response budget. Reduce its image outputs "
                                 "or use ssh_bash with jq to inspect selected cells.")
            blocks.append(block)
    except (TypeError, KeyError) as error:
        raise ValueError("Invalid Jupyter notebook cell or output: " + str(error)) from None
    return {"kind": "document", "blocks": blocks or [{"type": "text", "text": "Notebook has no cells."}]}


def poppler_output(command, snapshot, limit, deadline, cancel):
    """Bound subprocess output and lifetime, including cancellation by the worker."""
    snapshot.seek(0)
    process = subprocess.Popen(command, stdin=snapshot, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=dict(os.environ, LC_ALL="C"), start_new_session=True)
    output = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                if cancel is not None and cancel.is_set():
                    raise InterruptedError("PDF read cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("PDF rendering timed out; request fewer pages")
                if not selector.select(min(0.05, remaining)):
                    continue
                chunk = os.read(process.stdout.fileno(), min(65536, limit + 1 - len(output)))
                if not chunk:
                    selector.unregister(process.stdout)
                    continue
                output.extend(chunk)
                if len(output) > limit:
                    raise ValueError("PDF output exceeds the read budget; request fewer pages or export a smaller PDF")
        if process.returncode:
            raise ValueError("Poppler could not read this PDF; check whether the file is damaged or encrypted")
        return bytes(output)
    finally:
        # On macOS a group containing only an unreaped child can report EPERM.
        # Reap an exited leader, then stop any remaining descendants of the wrapper.
        process.poll()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # The exit may race the nonblocking poll above. A live executable
            # that cannot be signalled as a group still has its owned leader.
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                process.kill()
        finally:
            try:
                process.wait()
            finally:
                process.stdout.close()


def pdf_page_range(pages, total):
    """Validate page selection against the page count from the same snapshot."""
    if pages is None:
        if total > PDF_WHOLE_PAGES:
            raise ValueError("PDF has %d pages. Specify pages, for example \"1-10\" (at most 20 pages)." % total)
        return 1, total
    match = re.fullmatch(r"([1-9][0-9]*)(?:-([1-9][0-9]*))?", pages)
    if not match:
        raise ValueError("Specify a page number or an inclusive range, for example \"1-5\"")
    first = int(match.group(1))
    last = int(match.group(2) or match.group(1))
    if not 1 <= first <= last <= total:
        raise ValueError("Requested pages must be an ordered range within 1-%d" % total)
    if last - first + 1 > PDF_RANGE_PAGES:
        raise ValueError("Request at most 20 PDF pages at a time")
    return first, last


def read_pdf(data, request):
    """Render the exact bytes used for the revision with remote Poppler, one page per image."""
    for tool in ("pdftoppm", "pdfinfo"):
        if not shutil.which(tool):
            raise ValueError(tool + " is not installed. Install Poppler on the remote host to read PDFs.")
    deadline = time.monotonic() + 25
    cancel = request.get("_cancel_event")
    # Rendered pages can be much larger than a vector PDF. Reserve space for JSON and page labels.
    remaining = document_budget(request["maxFileBytes"])
    with tempfile.TemporaryFile() as snapshot:
        snapshot.write(data)
        info = poppler_output(["pdfinfo", "-"], snapshot, 65536, deadline, cancel)
        # pdfinfo prints free-form metadata before the authoritative page count.
        counts = re.findall(rb"^Pages:[ \t]+([1-9][0-9]*)[ \t]*$", info, re.MULTILINE)
        if not counts:
            raise ValueError("Poppler did not report the PDF page count")
        total = int(counts[-1])
        first, last = pdf_page_range(request["args"].get("pages"), total)
        blocks = []
        for page in range(first, last + 1):
            command = ["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile", "-png", "-scale-to", "1400", "-"]
            png = poppler_output(command, snapshot, remaining // 4 * 3, deadline, cancel)
            if image_mime_type(png) != "image/png":
                raise ValueError("Poppler returned an invalid page image")
            encoded = base64.b64encode(png).decode("ascii")
            remaining -= len(encoded)
            blocks.extend([{"type": "text", "text": "Page %d of %d" % (page, total)},
                           {"type": "image", "mimeType": "image/png", "data": encoded}])
    return {"kind": "document", "blocks": blocks, "startLine": first, "endLine": last,
            "totalLines": total, "truncated": first != 1 or last != total}
