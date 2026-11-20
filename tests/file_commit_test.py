"""Exercise same-worker revision conflicts with real files and deterministic commit gates."""
import base64
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
import file_ops
import read_formats


def pdf_bytes(pages):
    """Build a valid PDF with identical blank pages without any PDF-writing dependencies."""
    kids = " ".join("%d 0 R" % (index + 3) for index in range(pages))
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               ("<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, pages)).encode()]
    objects.extend([b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"] * pages)
    data = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, content in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(("%d 0 obj\n" % index).encode() + content + b"\nendobj\n")
    xref = len(data)
    size = len(objects) + 1
    data.extend(("xref\n0 %d\n0000000000 65535 f \n" % size).encode())
    for offset in offsets:
        data.extend(("%010d 00000 n \n" % offset).encode())
    data.extend(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)).encode())
    return bytes(data)


class FileCommitTests(unittest.TestCase):
    """Keep file mutations and every staged upload inside a temporary directory."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="neverssh-file-commit-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, operation, **args):
        """Build a worker request without bypassing the real dispatch boundary."""
        return {"op": operation, "cwd": str(self.root), "maxFileBytes": 1024 * 1024, "args": args}

    def test_read_recognizes_common_image_signatures_without_filename_hints(self):
        # These short signature samples exercise classification, not pixel decoding.
        signatures = (
            ("png", "image/png", b"\x89PNG\r\n\x1a\n"),
            ("jpeg", "image/jpeg", b"\xff\xd8\xff\xe0"),
            ("gif87", "image/gif", b"GIF87a"),
            ("gif89", "image/gif", b"GIF89a"),
            ("webp", "image/webp", b"RIFF\x10\x00\x00\x00WEBP"),
        )
        for name, mime_type, signature in signatures:
            with self.subTest(format=name):
                data = signature + b"\x00signature fixture"
                target = self.root / (name + ".txt")
                target.write_bytes(data)
                result = file_ops.dispatch(self.request("read", path=target.name))
                self.assertEqual(result, {
                    "kind": "image", "mimeType": mime_type,
                    "base64": base64.b64encode(data).decode("ascii"),
                    "path": str(target.resolve()), "size": len(data), "sha256": file_ops.digest(data),
                })

    def test_image_read_keeps_canonical_revision_and_ignores_text_pagination(self):
        data = b"\x89PNG\r\n\x1a\n\x00signature fixture"
        target = self.root / "image.data"
        alias = self.root / "image-alias"
        target.write_bytes(data)
        alias.symlink_to(target)
        result = file_ops.dispatch(self.request("read", path=alias.name, startLine=999,
                                               lineCount=1, maxBytes=1))
        self.assertEqual(result["kind"], "image")
        self.assertEqual(result["path"], str(target.resolve()))
        self.assertEqual(result["sha256"], file_ops.digest(data))
        self.assertEqual(base64.b64decode(result["base64"], validate=True), data)

    def test_image_reads_apply_the_full_file_byte_limit_before_encoding(self):
        target = self.root / "image"
        data = b"GIF89a" + b"\x00" * (1024 - 6)
        target.write_bytes(data)
        request = self.request("read", path=target.name)
        request["maxFileBytes"] = 1024
        self.assertEqual(file_ops.dispatch(request)["size"], 1024)
        target.write_bytes(data + b"x")
        with self.assertRaisesRegex(ValueError, "maxFileBytes"):
            file_ops.dispatch(request)

    def test_image_extensions_do_not_change_text_paging_or_accept_other_binary_formats(self):
        target = self.root / "actually-text.png"
        data = b"first\r\nsecond\r\nthird\r\n"
        target.write_bytes(data)
        result = file_ops.dispatch(self.request("read", path=target.name, startLine=2, lineCount=1))
        self.assertEqual(result["content"], "second\r\n")
        self.assertEqual((result["startLine"], result["endLine"], result["totalLines"]), (2, 2, 3))
        self.assertEqual(result["nextLine"], 3)
        self.assertTrue(result["truncated"])
        self.assertNotIn("kind", result)
        for name, content in (("other.jpg", b"\x00not an image"),
                              ("riff.webp", b"RIFF\x10\x00\x00\x00AVI \x00"),
                              ("short.png", b"\x89PNG\x00")):
            with self.subTest(path=name), self.assertRaisesRegex(ValueError, "Binary file"):
                (self.root / name).write_bytes(content)
                file_ops.dispatch(self.request("read", path=name))

    def test_image_reads_still_require_regular_files(self):
        directory = self.root / "directory.png"
        directory.mkdir()
        fifo = self.root / "fifo.jpg"
        os.mkfifo(fifo)
        for target in (directory, fifo):
            with self.subTest(path=target.name), self.assertRaises((ValueError, IsADirectoryError)):
                file_ops.dispatch(self.request("read", path=target.name))

    def test_paging_a_line_dense_file_keeps_memory_proportional_to_its_bytes(self):
        size = 2 * 1024 * 1024
        (self.root / "blank-lines.txt").write_bytes(b"\n" * size)
        request = self.request("read", path="blank-lines.txt", startLine=2, lineCount=2)
        request["maxFileBytes"] = size
        tracemalloc.start()
        try:
            result = file_ops.dispatch(request)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(result["content"], "\n\n")
        self.assertEqual(result["totalLines"], size)
        self.assertEqual(result["nextLine"], 4)
        self.assertLess(peak, 4 * size)

    def test_pdf_dependency_error_identifies_the_remote_tool(self):
        (self.root / "example.pdf").write_bytes(pdf_bytes(1))
        with patch.dict(os.environ, {"PATH": str(self.root)}):
            with self.assertRaisesRegex(ValueError, "pdftoppm is not installed"):
                file_ops.dispatch(self.request("read", path="example.pdf"))

    def test_pdf_renderer_reaps_fast_overflow_and_cancelled_processes(self):
        for cancel, command, error, message in (
            (False, ["/bin/sh", "-c", "printf 123456789"], ValueError, "exceeds the read budget"),
            (True, ["sleep", "30"], InterruptedError, "PDF read cancelled"),
        ):
            with self.subTest(command=command), tempfile.TemporaryFile() as snapshot:
                children = []
                stopped = threading.Event()
                popen = read_formats.subprocess.Popen

                def start(*args, **kwargs):
                    child = popen(*args, **kwargs)
                    children.append(child)
                    if cancel:
                        stopped.set()
                    return child

                with patch.object(read_formats.subprocess, "Popen", side_effect=start):
                    with self.assertRaisesRegex(error, message):
                        read_formats.poppler_output(command, snapshot, 8, time.monotonic() + 2, stopped)
                self.assertTrue(children[0].stdout.closed)
                with self.assertRaises(ChildProcessError):
                    os.waitpid(children[0].pid, os.WNOHANG)

    def test_pdf_page_ranges_are_checked_before_rendering(self):
        for pages, total in ((None, 11), ("3-1", 3), ("2-4", 3), ("1-21", 21), ("0", 21)):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                read_formats.pdf_page_range(pages, total)
        self.assertEqual(read_formats.pdf_page_range("2-21", 21), (2, 21))
        self.assertEqual(read_formats.pdf_page_range(None, 10), (1, 10))

    @unittest.skipUnless(shutil.which("pdftoppm") and shutil.which("pdfinfo"), "remote renderer requires Poppler")
    def test_real_pdf_pages_are_images_from_the_recorded_revision(self):
        target = self.root / "example.pdf"
        for total, pages, first, last in ((1, None, 1, 1), (23, "4-5", 4, 5)):
            data = pdf_bytes(total)
            target.write_bytes(data)
            args = {"pages": pages} if pages else {}
            result = file_ops.dispatch(self.request("read", path=target.name, **args))
            self.assertEqual(result["sha256"], file_ops.digest(data))
            self.assertEqual(result["truncated"], total != 1)
            blocks = result["blocks"]
            self.assertEqual(len(blocks), (last - first + 1) * 2)
            for index, page in enumerate(range(first, last + 1)):
                self.assertEqual(blocks[index * 2], {"type": "text", "text": "Page %d of %d" % (page, total)})
                image = blocks[index * 2 + 1]
                self.assertEqual(image["mimeType"], "image/png")
                self.assertTrue(base64.b64decode(image["data"], validate=True).startswith(b"\x89PNG\r\n\x1a\n"))

    def test_edit_previews_show_the_difference_inside_a_large_unique_match(self):
        target = self.root / "preview.txt"
        for prefix in ("context\n" * 20, "x" * 800):
            with self.subTest(prefix=prefix[:8]):
                old = prefix + "before" + "\nsuffix" * 20
                new = prefix + "after" + "\nsuffix" * 20
                target.write_text(old)
                result = file_ops.dispatch(self.request("edit", path=target.name, oldText=old, newText=new))
                lines = result["preview"]["lines"]
                self.assertTrue(any("after" in line["text"] for line in lines))
                self.assertLessEqual(len(lines), 5)

    def test_deleting_the_whole_file_returns_an_empty_preview(self):
        target = self.root / "empty.txt"
        target.write_bytes(b"remove me")
        result = file_ops.dispatch(self.request("edit", path=target.name, oldText="remove me", newText=""))
        self.assertEqual(result["preview"], {"lines": [], "truncated": False})
        self.assertEqual(target.read_bytes(), b"")

    def test_concurrent_edit_write_and_upload_recheck_the_revision_after_admission(self):
        # Pause the first writer after its final hash check, exposing the original lost-update window.
        for operation in ("edit", "write", "commit_upload"):
            with self.subTest(operation=operation):
                target = self.root / (operation + ".txt")
                alias = self.root / (operation + "-alias.txt")
                target.write_bytes(b"left right")
                alias.symlink_to(target)
                revision = file_ops.digest(target.read_bytes())
                first = self.request("edit", path=str(target), oldText="left", newText="first", expectedSha256=revision)
                if operation == "edit":
                    second = self.request("edit", path=str(alias), oldText="right", newText="second", expectedSha256=revision)
                elif operation == "write":
                    second = self.request("write", path=str(alias), base64=base64.b64encode(b"second").decode("ascii"),
                                          expectedSha256=revision)
                else:
                    staged = self.root / (operation + ".staged")
                    staged.write_bytes(b"second")
                    second = self.request("commit_upload", path=str(alias), temporary=str(staged), overwrite=True,
                                          sha256=file_ops.digest(b"second"), expectedSha256=revision)

                entered_commit = threading.Event()
                release_commit = threading.Event()
                second_admitted = threading.Event()
                results = []
                errors = []
                original_replace = file_ops.os.replace
                original_lock = file_ops.mutation_lock

                def gated_replace(source, destination):
                    """Hold only the first mutation between validation and its actual atomic rename."""
                    if threading.current_thread().name == "first-writer":
                        entered_commit.set()
                        if not release_commit.wait(5):
                            raise TimeoutError("First writer was not released")
                    return original_replace(source, destination)

                def observed_lock(filename):
                    """Confirm that the second thread has reached admission before releasing the first."""
                    if threading.current_thread().name == "second-writer":
                        second_admitted.set()
                    return original_lock(filename)

                def invoke(request):
                    """Capture both outcomes so a background exception cannot pass the regression test."""
                    try:
                        results.append(file_ops.dispatch(request))
                    except Exception as error:
                        errors.append(error)

                first_thread = threading.Thread(target=invoke, args=(first,), name="first-writer")
                second_thread = threading.Thread(target=invoke, args=(second,), name="second-writer")
                with patch.object(file_ops.os, "replace", gated_replace), patch.object(file_ops, "mutation_lock", observed_lock):
                    try:
                        first_thread.start()
                        self.assertTrue(entered_commit.wait(5))
                        second_thread.start()
                        self.assertTrue(second_admitted.wait(5))
                    finally:
                        release_commit.set()
                        first_thread.join(5)
                        if second_thread.ident is not None:
                            second_thread.join(5)

                self.assertFalse(first_thread.is_alive())
                self.assertFalse(second_thread.is_alive())
                self.assertEqual(len(results), 1)
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], ValueError)
                self.assertIn("Content conflict", str(errors[0]))
                self.assertEqual(target.read_bytes(), b"first right")
                self.assertTrue(alias.is_symlink())
                self.assertFalse(list(self.root.glob("*.staged")))

    def test_upload_create_if_absent_preserves_a_concurrent_creation(self):
        target = self.root / "target"
        staged = self.root / "upload.staged"
        target.write_bytes(b"concurrent writer")
        staged.write_bytes(b"upload")
        request = self.request("commit_upload", path=str(target), temporary=str(staged), overwrite=False,
                               sha256=file_ops.digest(b"upload"))
        with self.assertRaises(FileExistsError):
            file_ops.dispatch(request)
        self.assertEqual(target.read_bytes(), b"concurrent writer")
        self.assertFalse(staged.exists())

    def test_upload_verifies_staged_bytes_before_replacing_the_target(self):
        target = self.root / "target"
        staged = self.root / "upload.staged"
        target.write_bytes(b"original")
        staged.write_bytes(b"incomplete")
        request = self.request("commit_upload", path=str(target), temporary=str(staged), overwrite=True,
                               sha256=file_ops.digest(b"upload"))
        with self.assertRaisesRegex(ValueError, "verification failed"):
            file_ops.dispatch(request)
        self.assertEqual(target.read_bytes(), b"original")
        self.assertFalse(staged.exists())

    def test_transfer_stat_rejects_nonregular_files_and_their_aliases(self):
        directory = self.root / "directory"
        directory.mkdir()
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        for target in (directory, fifo):
            alias = self.root / (target.name + "-alias")
            alias.symlink_to(target)
            for path in (target, alias):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "regular file"):
                    file_ops.dispatch(self.request("stat", path=str(path)))

    def test_transfer_stat_keeps_the_canonical_target_of_a_dangling_alias(self):
        target = self.root / "missing-parent/target"
        alias = self.root / "alias"
        alias.symlink_to(target)

        result = file_ops.dispatch(self.request("stat", path=str(alias)))

        self.assertFalse(result["exists"])
        self.assertEqual(result["realpath"], str(target.resolve()))

    def test_hash_returns_the_canonical_path_of_a_regular_file(self):
        target = self.root / "target"
        target.write_bytes(b"contents")
        alias = self.root / "alias"
        alias.symlink_to(target)

        result = file_ops.dispatch(self.request("hash", path=str(alias)))

        self.assertEqual(result["path"], str(target.resolve()))
        self.assertEqual(result["sha256"], file_ops.digest(b"contents"))

    def test_upload_cannot_replace_a_nonregular_destination(self):
        target = self.root / "target"
        os.mkfifo(target)
        staged = self.root / "upload.staged"
        staged.write_bytes(b"upload")

        with self.assertRaisesRegex(ValueError, "regular file"):
            file_ops.dispatch(self.request("commit_upload", path=str(target), temporary=str(staged),
                                           overwrite=True, sha256=file_ops.digest(b"upload")))

        self.assertTrue(stat.S_ISFIFO(target.lstat().st_mode))
        self.assertFalse(staged.exists())

    def test_upload_rejects_symlinked_staging_files_without_moving_their_targets(self):
        source = self.root / "source"
        source.write_bytes(b"upload")
        for overwrite in (False, True):
            with self.subTest(overwrite=overwrite):
                target = self.root / ("target-%s" % overwrite)
                if overwrite:
                    target.write_bytes(b"original")
                staged = self.root / ("upload-%s.staged" % overwrite)
                staged.symlink_to(source)

                with self.assertRaisesRegex(ValueError, "regular file"):
                    file_ops.dispatch(self.request("commit_upload", path=str(target), temporary=str(staged),
                                                   overwrite=overwrite, sha256=file_ops.digest(b"upload")))

                self.assertFalse(os.path.lexists(staged))
                self.assertEqual(source.read_bytes(), b"upload")
                if overwrite:
                    self.assertEqual(target.read_bytes(), b"original")
                else:
                    self.assertFalse(os.path.lexists(target))

    def test_upload_cleans_a_broken_staging_symlink_after_rejecting_it(self):
        target = self.root / "target"
        staged = self.root / "upload.staged"
        staged.symlink_to(self.root / "absent")

        with self.assertRaisesRegex(ValueError, "regular file"):
            file_ops.dispatch(self.request("commit_upload", path=str(target), temporary=str(staged),
                                           overwrite=True, sha256=file_ops.digest(b"upload")))

        self.assertFalse(os.path.lexists(staged))
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
