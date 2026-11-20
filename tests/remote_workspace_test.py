"""Exercise workspace guidance, discovery budgets, and resource boundaries using real files."""
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "remote"))
import workspace


class WorkspaceTests(unittest.TestCase):
    """Keep project files, external skills, and Git settings within a temporary tree."""

    def setUp(self):
        # Runner-wide filters can exhaust tiny inspection budgets before status is read.
        # Keep repository-local settings available for the filter/fsmonitor safety cases.
        git_environment = patch.dict(os.environ, {"GIT_CONFIG_NOSYSTEM": "1",
                                                  "GIT_CONFIG_SYSTEM": os.devnull,
                                                  "GIT_CONFIG_GLOBAL": os.devnull})
        git_environment.start()
        self.addCleanup(git_environment.stop)
        self.temporary = tempfile.TemporaryDirectory(prefix="neverssh-workspace-")
        self.home = Path(self.temporary.name).resolve()
        self.root = self.home / "project"
        self.root.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, content):
        """Create a UTF-8 fixture relative to the project or at an explicit absolute path."""
        filename = self.root / path
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(content, encoding="utf-8")
        return filename

    def invoke(self, operation="workspace_open", max_file_bytes=4 * 1024 * 1024, **args):
        """Exercise the normal dispatcher and file byte budget, without an SSH connection."""
        if operation == "workspace_context":
            args.setdefault("root", str(self.root))
        elif operation == "workspace_open":
            args.setdefault("path", str(self.root))
        return workspace.dispatch({"op": operation, "cwd": str(self.home),
                                   "maxFileBytes": max_file_bytes, "args": args})

    def skill(self, path, name="example", body="body"):
        """Create metadata plus a distinct body so discovery cannot accidentally preload it."""
        return self.write(path, "---\nname: %s\ndescription: Example skill\n---\n%s" % (name, body))

    def test_open_discovers_only_root_instructions_and_entry_names(self):
        self.write("AGENTS.md", "root rules")
        self.write("backend/AGENTS.md", "backend rules")
        self.write("README.md", "read me")
        self.write("package.json", "{}")
        result = self.invoke("workspace_open", path="project")
        self.assertEqual(result["root"], str(self.root))
        self.assertEqual([rule["content"] for rule in result["instructions"]], ["root rules"])
        self.assertIn(str(self.root / "package.json"), result["project_files"])
        self.assertIsNone(result["git"])

    def test_context_includes_new_file_ancestors_without_other_subtrees(self):
        self.write("AGENTS.md", "root")
        self.write("backend/AGENTS.md", "backend")
        self.write("frontend/AGENTS.md", "frontend")
        result = self.invoke("workspace_context", paths=["backend/new/deep.py", "backend"])
        self.assertEqual([rule["content"] for rule in result["instructions"]], ["root", "backend"])
        self.assertEqual(result["skill_files"], [])
        self.assertEqual(result["project_files"], [])
        self.assertIsNone(result["git"])

    def test_operation_context_loads_rules_without_catalogs_or_git(self):
        self.write("backend/AGENTS.md", "backend rules")
        self.write("backend/package.json", "{}")
        self.skill("backend/.agents/skills/api/SKILL.md", "api")
        self.skill("backend/.claude/skills/check/SKILL.md", "check")
        self.skill(".agents/skills/root/SKILL.md", "root")
        with patch.object(workspace, "git_details") as git, patch.object(workspace, "skills_for") as skills:
            result = self.invoke("workspace_context", paths=["backend/new.py"])
        git.assert_not_called()
        skills.assert_not_called()
        self.assertEqual(result["skill_files"], [])
        self.assertEqual([rule["content"] for rule in result["instructions"]], ["backend rules"])
        self.assertEqual(result["project_files"], [])

    def test_internal_symlink_preserves_both_ancestor_chains_in_order(self):
        self.write("AGENTS.md", "root")
        self.write("alias-parent/AGENTS.md", "alias parent")
        self.write("real-parent/AGENTS.md", "real parent")
        self.write("real-parent/child/AGENTS.md", "child")
        (self.root / "alias-parent/link").symlink_to(self.root / "real-parent/child", target_is_directory=True)
        result = self.invoke("workspace_context", paths=["alias-parent/link/new.py"])
        self.assertEqual([rule["content"] for rule in result["instructions"]],
                         ["root", "alias parent", "real parent", "child"])
        self.assertEqual(result["paths"], [str(self.root / "alias-parent/link/new.py"),
                                           str(self.root / "real-parent/child/new.py")])

    def test_symlinked_instruction_sources_keep_each_applicable_scope(self):
        source = self.write("shared/rules.md", "shared instructions")
        for directory in ("a", "b"):
            (self.root / directory).mkdir()
            (self.root / directory / "AGENTS.md").symlink_to(source)
        result = self.invoke("workspace_context", paths=["a/file.py", "b/file.py"])
        self.assertEqual([rule["scope"] for rule in result["instructions"]],
                         [str(self.root / "a"), str(self.root / "b")])
        self.assertEqual([rule["path"] for rule in result["instructions"]],
                         [str(self.root / "a/AGENTS.md"), str(self.root / "b/AGENTS.md")])

    def test_outside_paths_prefix_collisions_and_symlinked_rules_are_rejected(self):
        outside = self.write(self.home / "project-other/AGENTS.md", "outside")
        (self.root / "escape").symlink_to(outside.parent, target_is_directory=True)
        for path in ("../project-other/file.py", str(outside), "escape/new.py"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "outside the workspace"):
                self.invoke("workspace_context", paths=[path])
        (self.root / "AGENTS.md").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "outside the workspace"):
            self.invoke()

    def test_oversized_and_special_instruction_files_fail_without_partial_guidance(self):
        rule = self.write("AGENTS.md", "x" * (workspace.RULE_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "Cannot load project instructions"):
            self.invoke()
        rule.unlink()
        os.mkfifo(str(rule))
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.invoke()

    def test_instruction_and_directory_budget_exhaustion_cannot_silently_drop_rules(self):
        self.write("AGENTS.md", "a" * 60000)
        self.write("nested/AGENTS.md", "b" * 60000)
        self.write("nested/deeper/AGENTS.md", "c" * 60000)
        with self.assertRaisesRegex(ValueError, "128 KiB context budget"):
            self.invoke("workspace_context", paths=["nested/deeper/new.py"])
        with patch.object(workspace, "DIRECTORY_COUNT", 1):
            with self.assertRaisesRegex(ValueError, "directory budget"):
                self.invoke("workspace_context", paths=["nested/new.py"])

    def test_small_file_limit_rejects_escaped_rules_before_transport_cancellation(self):
        directory = Path(".")
        for _ in range(25):
            self.write(directory / "AGENTS.md", "\x01" * 1024)
            directory /= "nested"
        with self.assertRaisesRegex(ValueError, "transport byte budget.*fewer paths or skill_directories"):
            self.invoke("workspace_context", max_file_bytes=1024, paths=[str(directory / "new.py")])

    def test_open_transport_budget_accounts_for_catalog_rules_and_git_together(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        self.write("AGENTS.md", "\x01" * 1024)
        for index in range(100):
            self.write(".agents/skills/skill-%d/SKILL.md" % index,
                       "---\nname: skill-%d\ndescription: %s\n---\n" % (index, "a" * 650))
        for index in range(300):
            self.write("change-%03d-%s" % (index, "x" * 220), "change")
        with patch.object(workspace, "git_details", return_value=None):
            without_git = self.invoke(max_file_bytes=1024)
        self.assertEqual(len(without_git["instructions"]), 1)
        self.assertEqual(len(without_git["skill_files"]), 100)
        with self.assertRaisesRegex(ValueError, "transport byte budget"):
            self.invoke(max_file_bytes=1024)

    def test_git_cancellation_reaps_processes_before_and_after_stdout_closes(self):
        binary = self.home / "bin"
        binary.mkdir()
        for closes_stdout in (False, True):
            with self.subTest(closes_stdout=closes_stdout):
                marker = self.home / "git.pid"
                marker.unlink(missing_ok=True)
                script = "#!/bin/sh\nprintf '%s\\n' \"$$\" > " + shlex.quote(str(marker)) + "\n"
                if closes_stdout:
                    script += "exec 1>&-\n"
                executable = self.write(binary / "git", script + "exec sleep 30\n")
                executable.chmod(0o700)
                cancelled = threading.Event()
                errors = []

                def inspect():
                    """Retain the cancellation result from the real subprocess-owning thread."""
                    try:
                        workspace.git_command(str(self.root), ["status"], 1024, cancelled)
                    except Exception as error:
                        errors.append(error)

                with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
                    thread = threading.Thread(target=inspect)
                    thread.start()
                    try:
                        deadline = time.monotonic() + 2
                        while not marker.exists() or not marker.read_text().strip():
                            self.assertLess(time.monotonic(), deadline)
                            time.sleep(0.005)
                        pid = int(marker.read_text())
                        cancelled.set()
                        thread.join(1)
                        self.assertFalse(thread.is_alive())
                        self.assertEqual(len(errors), 1)
                        self.assertIsInstance(errors[0], InterruptedError)
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
                    finally:
                        cancelled.set()
                        thread.join(6)

    def test_git_cancellation_stops_children_of_a_git_wrapper(self):
        binary = self.home / "bin"
        binary.mkdir()
        marker = self.home / "git-child.pid"
        executable = self.write(binary / "git", "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' \"$!\" > "
                                + shlex.quote(str(marker)) + "\nwait\n")
        executable.chmod(0o700)
        cancelled = threading.Event()
        errors = []

        def inspect():
            try:
                workspace.git_command(str(self.root), ["status"], 1024, cancelled)
            except Exception as error:
                errors.append(error)

        child_pid = None
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
            thread = threading.Thread(target=inspect)
            thread.start()
            try:
                deadline = time.monotonic() + 2
                while not marker.exists() or not marker.read_text().strip():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.005)
                child_pid = int(marker.read_text())
                cancelled.set()
                thread.join(1)
                self.assertFalse(thread.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], InterruptedError)
                state = subprocess.run(["ps", "-p", str(child_pid), "-o", "stat="],
                                       capture_output=True, text=True, check=False).stdout.strip()
                self.assertTrue(not state or state.startswith("Z"), "Git wrapper child still running: " + state)
            finally:
                cancelled.set()
                thread.join(6)
                if child_pid is not None:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_metadata_is_lazy_root_scoped_and_supports_explicit_external_directories(self):
        root_skill = self.skill(".agents/skills/root/SKILL.md", "root", "x" * 200000)
        claude_skill = self.skill(".claude/skills/check/SKILL.md", "check")
        self.skill("backend/.claude/skills/api/SKILL.md", "api")
        self.skill("frontend/.agents/skills/ui/SKILL.md", "ui")
        shared_skill = self.skill(self.home / "shared/build/SKILL.md", "build")
        with patch.dict(os.environ, {"HOME": str(self.home)}):
            result = self.invoke(skillDirectories=[".agents/skills", ".claude/skills", "~/shared"])
        metadata = [entry["content"] for entry in result["skill_files"]]
        self.assertEqual(len(metadata), 3)
        self.assertEqual({entry["path"] for entry in result["skill_files"]},
                         {str(root_skill), str(claude_skill), str(shared_skill)})
        self.assertEqual({entry["scope"] for entry in result["skill_files"]}, {str(self.root)})
        self.assertTrue(all("---" not in entry and "body" not in entry and "xxx" not in entry for entry in metadata))
        self.assertTrue(any("name: build" in entry for entry in metadata))

    def test_configured_roots_replace_defaults_and_empty_list_disables_skills(self):
        self.skill(".agents/skills/default/SKILL.md", "default")
        self.skill("custom/selected/SKILL.md", "selected")
        self.skill("backend/custom/ignored/SKILL.md", "ignored")
        result = self.invoke(skillDirectories=["custom"])
        self.assertEqual(len(result["skill_files"]), 1)
        self.assertIn("name: selected", result["skill_files"][0]["content"])
        self.assertEqual(result["skill_files"][0]["scope"], str(self.root))
        self.assertEqual(self.invoke(skillDirectories=[])["skill_files"], [])

    def test_default_skill_root_cannot_implicitly_authorize_an_external_symlink(self):
        outside = self.skill(self.home / "outside/test/SKILL.md")
        (self.root / ".agents").mkdir()
        (self.root / ".agents/skills").symlink_to(outside.parent.parent, target_is_directory=True)
        result = self.invoke(skillDirectories=[".agents/skills"])
        self.assertEqual(result["skill_files"], [])
        self.assertTrue(any("configure it explicitly" in warning for warning in result["warnings"]))
        self.assertEqual(len(self.invoke(skillDirectories=[str(outside.parent.parent)])["skill_files"]), 1)

    def test_invalid_metadata_and_skill_symlink_escapes_have_explicit_warnings(self):
        self.write(".agents/skills/invalid/SKILL.md", "missing metadata")
        outside = self.skill(self.home / "outside/escape/SKILL.md")
        (self.root / ".agents/skills/escape").symlink_to(outside.parent, target_is_directory=True)
        result = self.invoke()
        self.assertEqual(result["skill_files"], [])
        self.assertTrue(any("frontmatter" in warning for warning in result["warnings"]))
        self.assertTrue(any("outside its configured directory" in warning for warning in result["warnings"]))

    def test_indented_document_markers_remain_part_of_frontmatter(self):
        self.write(".agents/skills/block/SKILL.md", "---\nname: block\ndescription: |\n  ---\n  Description\n---\nbody")
        metadata = self.invoke()["skill_files"][0]["content"]
        self.assertIn("  ---\n  Description", metadata)
        self.assertNotIn("body", metadata)

    def test_catalog_and_shared_content_budgets_report_incompleteness(self):
        self.skill(".agents/skills/a/SKILL.md", "a")
        self.skill(".agents/skills/b/SKILL.md", "b")
        with patch.object(workspace, "SKILL_COUNT", 1):
            result = self.invoke()
        self.assertEqual(len(result["skill_files"]), 1)
        self.assertTrue(any("truncated after 1 skills" in warning for warning in result["warnings"]))
        self.write("AGENTS.md", "rules")
        with patch.object(workspace, "CONTEXT_BYTES", 8):
            result = self.invoke()
        self.assertEqual([rule["content"] for rule in result["instructions"]], ["rules"])
        self.assertEqual(result["skill_files"], [])
        self.assertTrue(any("shared 128 KiB context budget" in warning for warning in result["warnings"]))
        with patch.object(workspace, "SCAN_ENTRIES", 1):
            result = self.invoke()
        self.assertTrue(any("scan budget" in warning for warning in result["warnings"]))

    def test_skill_resources_are_lazy_text_and_stay_inside_the_skill(self):
        manifest = self.skill(".agents/skills/test/SKILL.md")
        resource = self.write(".agents/skills/test/scripts/check.py", "print('ok')")
        outside = self.write(self.home / "outside.txt", "outside")
        (manifest.parent / "escaped.txt").symlink_to(outside)
        result = self.invoke("workspace_skill_read", path=str(manifest), resource="scripts/check.py")
        self.assertEqual(result["content"], "print('ok')")
        self.assertEqual(result["path"], str(resource))
        self.assertIn("scripts/check.py", result["resources"])
        self.assertTrue(result["warnings"])
        for name in ("../outside.txt", str(outside), "escaped.txt"):
            with self.subTest(resource=name), self.assertRaises(ValueError):
                self.invoke("workspace_skill_read", path=str(manifest), resource=name)
        with patch.object(workspace, "SCAN_ENTRIES", 1):
            result = self.invoke("workspace_skill_read", path=str(manifest))
        self.assertTrue(any("scan budget" in warning for warning in result["warnings"]))

    def test_registered_root_and_skill_directory_replacement_cannot_rebase_reads(self):
        manifest = self.skill(".agents/skills/test/SKILL.md")
        outside = self.write(self.home / "outside/SKILL.md", "outside")
        manifest.unlink()
        manifest.parent.rmdir()
        manifest.parent.symlink_to(outside.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "outside its skill directory"):
            self.invoke("workspace_skill_read", path=str(manifest))
        self.root.rename(self.home / "previous-project")
        self.root.symlink_to(outside.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Workspace root changed"):
            self.invoke("workspace_context")

    def test_git_reports_user_changes_caps_output_and_ignores_repository_redirection(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        self.write("existing.txt", "user change")
        with patch.dict(os.environ, {"GIT_DIR": str(self.home / "wrong-git")}):
            result = self.invoke()
        self.assertEqual(result["git"]["root"], str(self.root))
        self.assertIn("existing.txt", result["git"]["status"])
        self.assertFalse(result["git"]["truncated"])
        with patch.object(workspace, "GIT_BYTES", 5):
            result = self.invoke()
        self.assertTrue(result["git"]["truncated"])
        self.assertEqual(len(result["git"]["status"].encode()), 5)
        self.assertTrue(any("Git status truncated" in warning for warning in result["warnings"]))

    def test_git_timeout_is_reported_and_does_not_hide_loaded_rules(self):
        self.write("AGENTS.md", "root rules")
        with patch.object(workspace, "git_command", side_effect=TimeoutError("Git inspection timed out")):
            result = self.invoke()
        self.assertIsNone(result["git"])
        self.assertEqual(result["instructions"][0]["content"], "root rules")
        self.assertTrue(any("timed out" in warning for warning in result["warnings"]))

    def test_nested_workspace_git_status_excludes_sibling_changes(self):
        subprocess.run(["git", "init", "--quiet", str(self.home)], check=True)
        self.write("inside.txt", "inside change")
        self.write(self.home / "outside.txt", "outside change")
        result = self.invoke()
        self.assertEqual(result["git"]["root"], str(self.home))
        self.assertEqual(result["git"]["status"], "?? ./\n")
        self.assertNotIn("outside.txt", result["git"]["status"])

    def test_automatic_git_status_does_not_execute_filters_or_fsmonitor(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        command = ["git", "-C", str(self.root), "-c", "user.name=NeverSSH Test",
                   "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]
        self.write(".gitattributes", "clean.txt filter=demo\nprocess.txt filter=processor\n")
        self.write("clean.txt", "original\n")
        self.write("process.txt", "original\n")
        subprocess.run(command + ["add", "."], check=True, capture_output=True)
        subprocess.run(command + ["commit", "--quiet", "-m", "Initial files"], check=True, capture_output=True)
        settings = {
            "filter.demo.clean": "touch .clean-ran; cat",
            "filter.demo.required": "true",
            "filter.processor.process": "touch .process-ran; exit 1",
            "filter.processor.required": "true",
            "core.fsmonitor": "touch .monitor-ran; exit 1",
        }
        for key, value in settings.items():
            subprocess.run(command + ["config", key, value], check=True, capture_output=True)
        for name in ("clean.txt", "process.txt"):
            filename = self.write(name, "modified\n")
            info = filename.stat()
            os.utime(filename, (info.st_atime, info.st_mtime + 10))
        result = self.invoke()
        self.assertIsNotNone(result["git"])
        self.assertIn(" M clean.txt", result["git"]["status"])
        self.assertIn(" M process.txt", result["git"]["status"])
        for marker in (".clean-ran", ".process-ran", ".monitor-ran"):
            self.assertFalse((self.root / marker).exists(), marker)
        self.assertTrue(any("filter normalization" in warning for warning in result["warnings"]))

    def test_automatic_git_status_rejects_filter_names_that_cannot_be_overridden(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        command = ["git", "-C", str(self.root), "-c", "user.name=NeverSSH Test",
                   "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]
        self.write("AGENTS.md", "Root guidance.\n")
        self.write(".gitattributes", "value.txt filter=demo=unsafe\n")
        self.write("value.txt", "original\n")
        subprocess.run(command + ["add", "."], check=True, capture_output=True)
        subprocess.run(command + ["commit", "--quiet", "-m", "Initial files"], check=True, capture_output=True)
        subprocess.run(command + ["config", "filter.demo=unsafe.clean", "touch .filter-ran; cat"],
                       check=True, capture_output=True)
        modified = self.write("value.txt", "modified\n")
        info = modified.stat()
        os.utime(modified, (info.st_atime, info.st_mtime + 10))

        result = self.invoke()

        self.assertFalse((self.root / ".filter-ran").exists())
        self.assertIsNone(result["git"])
        self.assertEqual([rule["content"] for rule in result["instructions"]], ["Root guidance.\n"])
        self.assertTrue(any("filter" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
