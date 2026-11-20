"""Classify remote files and read saved Jupyter notebook outputs."""
import base64
import json
import os


TEXT_READ_BYTES = 256 * 1024
BINARY_EXTENSIONS = frozenset("""
    .7z .a .aac .apk .arrow .avi .avif .bin .bmp .bz2 .class .db .dll .dmg
    .doc .docm .docx .dylib .eot .epub .exe .feather .flac .gz .h5 .hdf5 .heic .heif .ico .jar
    .m4a .mkv .mov .mp3 .mp4 .npy .npz .o .ods .odt .ogg .otf .parquet
    .pkl .ppt .pptm .pptx .psd .pyc .rar .safetensors .so .sqlite .sqlite3 .tar .tgz .tif .tiff .ttf
    .wasm .wav .webm .woff .woff2 .xls .xlsm .xlsx .xz .zip .zst
""".split())


def file_format(data, *paths):
    """Recognize unsupported binaries and notebooks by their contents and known path spellings."""
    extensions = [os.path.splitext(path)[1].lower() for path in paths]
    if data[:1024].lstrip().startswith(b"%PDF-") or ".pdf" in extensions:
        return ".pdf"
    if ".ipynb" in extensions:
        return ".ipynb"
    return next((extension for extension in extensions if extension in BINARY_EXTENSIONS), "")


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
    # Reserve room for revision metadata and envelopes on both transports.
    remaining = min(9 * 1024 * 1024, max_file_bytes * 6 + 131072) - 8192
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
