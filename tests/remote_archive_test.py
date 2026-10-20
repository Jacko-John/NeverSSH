"""Exercise retention and quotas against real POSIX locks and temporary archive files."""
import json
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
from archive import ArchiveError, ArchiveStore, RETENTION_SECONDS, write_metadata

COMMAND = "fixture"


def competing_writer(root, task_id, barrier, results):
    """Model independent helpers writing against the same remote user's budget."""
    store = ArchiveStore(8192, 8192, root)
    task = store.new_task("1234abcd", task_id, COMMAND)
    try:
        barrier.wait(timeout=10)
        for _ in range(100):
            if len(task.append(b"x" * 100)) < 100:
                break
        results.put(task.bytes)
    finally:
        task.finish(-15, "output_limit")
        store.close()


class ArchiveTests(unittest.TestCase):
    """Use a private archive root; no user SSH or home directory is accessed."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="neverssh-archive-test-")
        self.root = Path(self.temporary.name)
        self.store = ArchiveStore(4096, 8192, str(self.root))
        self.session = self.store.new_session("1234abcd")

    def tearDown(self):
        os.close(self.session)
        self.store.close()
        self.temporary.cleanup()

    def task(self, task_id="task_12345678"):
        """Allocate output within the owned session using production path validation."""
        return self.store.new_task("1234abcd", task_id, COMMAND)

    def test_private_paths_and_atomic_id_collisions(self):
        task = self.task()
        task.append(b"preserve me")
        task.finish(0, None)
        with self.assertRaises(ArchiveError) as collision:
            self.task()
        self.assertEqual(collision.exception.code, "TASK_ID_EXISTS")
        with self.assertRaises(ArchiveError) as collision:
            self.store.new_session("1234abcd")
        self.assertEqual(collision.exception.code, "SESSION_ID_EXISTS")
        self.assertEqual(Path(task.path).read_bytes()[task.output_offset:], b"preserve me")
        self.assertEqual(stat.S_IMODE(os.stat(task.path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(Path(task.path).parent).st_mode), 0o700)

    def test_cleanup_rate_limit_marker(self):
        self.assertTrue(self.store.cleanup_due())
        self.store.mark_cleanup()
        self.assertFalse(self.store.cleanup_due())

    def test_original_multiline_command_is_preserved_in_log_and_metadata(self):
        command = "printf '%s\\n' '中文 $value'\n# trailing whitespace  \n"
        task = self.store.new_task("1234abcd", "task_aabbccdd", command)
        # The command record exists before output or process startup.
        expected_header = ("Command:\n" + command + "\n\nOutput:\n").encode("utf-8")
        self.assertEqual(Path(task.path).read_bytes(), expected_header)
        task.append(b"result\n")
        task.finish(0, None)
        metadata = json.loads(Path(task.metadata_path).read_text())
        self.assertEqual(metadata["command"], command)
        self.assertEqual(metadata["output_offset"], len(expected_header))
        self.assertEqual(metadata["output_bytes"], 7)
        self.assertEqual(metadata["file_bytes"], len(expected_header) + 7)
        self.assertEqual(Path(task.path).read_bytes(), expected_header + b"result\n")

    def test_command_header_must_fit_the_budget_before_creating_a_task(self):
        with self.assertRaises(ArchiveError) as full:
            self.store.new_task("1234abcd", "task_abcdef12", "x" * 4096)
        self.assertEqual(full.exception.code, "OUTPUT_LIMIT_REACHED")
        self.assertFalse((self.root / "sessions" / "1234abcd" / "task_abcdef12.log").exists())

    def test_finished_logs_expire_fourteen_days_after_completion(self):
        task = self.task()
        task.append(b"finished")
        task.finish(7, None)
        metadata = json.loads(Path(task.metadata_path).read_text())
        self.assertEqual(metadata["exit_code"], 7)
        self.assertEqual(metadata["output_bytes"], 8)
        from datetime import datetime
        finished = datetime.fromisoformat(metadata["finished_at"]).timestamp()
        # Reading and changing mtime must not extend a recorded completion-based expiry.
        Path(task.path).read_bytes()
        os.utime(task.path, (finished + RETENTION_SECONDS, finished + RETENTION_SECONDS))
        self.store.cleanup(now=finished + RETENTION_SECONDS - 1)
        self.assertTrue(Path(task.path).exists())
        self.store.cleanup(now=finished + RETENTION_SECONDS)
        self.assertFalse(Path(task.path).exists())
        self.assertFalse(Path(task.metadata_path).exists())
        self.assertTrue(Path(task.path).parent.exists())

    def test_unknown_archive_format_is_not_deleted(self):
        task = self.task()
        task.append(b"future")
        task.finish(0, None)
        metadata = json.loads(Path(task.metadata_path).read_text())
        metadata["format"] = 99
        write_metadata(task.metadata_path, metadata)
        from datetime import datetime
        finished = datetime.fromisoformat(metadata["finished_at"]).timestamp()
        self.store.cleanup(now=finished + RETENTION_SECONDS + 1)
        self.assertTrue(Path(task.path).exists())
        self.assertTrue(Path(task.metadata_path).exists())

    def test_active_lock_protects_even_old_logs_and_metadata(self):
        task = self.task()
        try:
            task.append(b"still running")
            old = time.time() - 30 * 86400
            os.utime(task.path, (old, old))
            write_metadata(task.metadata_path, {"finished_at": "2000-01-01T00:00:00+00:00"})
            self.store.cleanup()
            self.assertTrue(Path(task.path).exists())
            self.assertEqual(task.append(b"!"), b"!")
        finally:
            task.finish(0, None)

    def test_orphan_log_uses_last_write_and_empty_inactive_session_is_pruned(self):
        task = self.task()
        task.append(b"orphan")
        task.close()
        modified = os.stat(task.path).st_mtime
        self.store.cleanup(now=modified + RETENTION_SECONDS - 1)
        self.assertTrue(Path(task.path).exists())
        # Release the worker's session lock to model an exited connection.
        os.close(self.session)
        self.session = os.open(self.root, os.O_RDONLY)
        self.store.cleanup(now=modified + RETENTION_SECONDS)
        self.assertFalse(Path(task.path).parent.exists())

    def test_per_task_limit_preserves_a_prefix_without_evicting_other_logs(self):
        task = self.task()
        self.assertEqual(len(task.append(b"x" * 5000)), 4096 - task.output_offset)
        self.assertEqual(task.bytes, 4096)
        self.assertEqual(task.append(b"extra"), b"")
        task.finish(-15, "output_limit")
        metadata = json.loads(Path(task.metadata_path).read_text())
        self.assertFalse(metadata["output_complete"])
        self.assertEqual(Path(task.path).stat().st_size, 4096)

    def test_shared_budget_is_enforced_across_independent_store_descriptors(self):
        other = ArchiveStore(8192, 8192, str(self.root))
        first = self.task()
        second = other.new_task("1234abcd", "task_87654321", COMMAND)
        try:
            self.assertEqual(len(first.append(b"a" * 4096)), 4096 - first.output_offset)
            self.assertEqual(len(second.append(b"b" * 5000)), 4096 - second.output_offset)
            self.assertEqual(second.append(b"extra"), b"")
            with self.assertRaises(ArchiveError) as full:
                self.store.new_task("1234abcd", "task_aaaaaaaa", COMMAND)
            self.assertEqual(full.exception.code, "OUTPUT_LIMIT_REACHED")
            self.assertTrue(Path(first.path).exists())
        finally:
            first.finish(0, None)
            second.finish(-15, "output_limit")
            other.close()

    def test_reconcile_reclaims_a_crashed_reservation_without_deleting_logs(self):
        task = self.task()
        task.append(b"real bytes")
        task.finish(0, None)
        with self.store.guard():
            self.store.set_usage(8192)
        self.store.cleanup()
        with self.store.guard():
            self.assertEqual(self.store.usage(), task.output_offset + 10)
        self.assertEqual(Path(task.path).read_bytes()[task.output_offset:], b"real bytes")

    def test_concurrent_processes_cannot_overrun_the_shared_budget(self):
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(2)
        results = context.Queue()
        writers = [context.Process(target=competing_writer, args=(str(self.root), task_id, barrier, results))
                   for task_id in ("task_11111111", "task_22222222")]
        try:
            for writer in writers:
                writer.start()
            counts = [results.get(timeout=10) for _ in writers]
            for writer in writers:
                writer.join(timeout=10)
                self.assertEqual(writer.exitcode, 0)
            self.assertEqual(sum(counts), 8192)
            with self.store.guard():
                self.assertEqual(self.store.total_bytes(), 8192)
        finally:
            for writer in writers:
                if writer.is_alive():
                    writer.terminate()
                writer.join(timeout=5)
            results.close()

    def test_partial_write_failure_rolls_back_only_the_unwritten_quota(self):
        task = self.task()
        original_write = os.write
        writes = 0

        def partial_write(descriptor, data):
            """Persist a real prefix, then model disk exhaustion on the remaining bytes."""
            nonlocal writes
            writes += 1
            if writes == 1:
                return original_write(descriptor, data[:2])
            raise OSError("simulated disk full")

        try:
            with patch("archive.os.write", side_effect=partial_write):
                with self.assertRaises(OSError):
                    task.append(b"abcdef")
            self.assertEqual(task.bytes, task.output_offset + 2)
            with self.store.guard():
                self.assertEqual(self.store.usage(), task.output_offset + 2)
            self.assertEqual(Path(task.path).read_bytes()[task.output_offset:], b"ab")
        finally:
            task.finish(-15, "output_error")

    def test_invalid_metadata_falls_back_to_last_write_for_an_inactive_task(self):
        task = self.task()
        task.append(b"orphan")
        task.close()
        write_metadata(task.metadata_path, [])
        modified = os.stat(task.path).st_mtime
        self.store.cleanup(now=modified + RETENTION_SECONDS)
        self.assertFalse(Path(task.path).exists())

    def test_large_command_metadata_keeps_completion_based_retention(self):
        store = ArchiveStore(131072, 262144, str(self.root))
        try:
            task = store.new_task("1234abcd", "task_aabbccdd", "#" + "x" * 20000)
            task.finish(0, None)
            metadata = json.loads(Path(task.metadata_path).read_text())
            from datetime import datetime
            finished = datetime.fromisoformat(metadata["finished_at"]).timestamp()
            os.utime(task.path, (finished + RETENTION_SECONDS, finished + RETENTION_SECONDS))
            store.cleanup(now=finished + RETENTION_SECONDS)
            self.assertFalse(Path(task.path).exists())
        finally:
            store.close()

    def test_symlink_root_is_rejected_and_unrelated_files_survive_cleanup(self):
        external = self.root / "external"
        external.mkdir()
        link = self.root / "link"
        link.symlink_to(external)
        with self.assertRaises(ArchiveError):
            ArchiveStore(1024, 8192, str(link))
        marker = self.root / "sessions" / "keep-me.txt"
        marker.write_text("unrelated")
        self.store.cleanup(now=time.time() + RETENTION_SECONDS * 2)
        self.assertEqual(marker.read_text(), "unrelated")


if __name__ == "__main__":
    unittest.main()
