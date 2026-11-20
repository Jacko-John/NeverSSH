"""Exercise same-worker revision conflicts with real files and deterministic commit gates."""
import base64
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
import file_ops


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
