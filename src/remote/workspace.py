"""Discover bounded workspace guidance and read skill resources without executing project code."""
import json
import os
import selectors
import signal
import stat
import subprocess
import time

from file_ops import digest, load_bytes, path_for, text_from


RULE_BYTES = 65536
CONTEXT_BYTES = 131072
DIRECTORY_COUNT = 256
SKILL_COUNT = 128
RESOURCE_COUNT = 128
PROJECT_COUNT = 128
SCAN_ENTRIES = 512
GIT_BYTES = 65536
GIT_STATUS_ENTRIES = 50
GIT_TIMEOUT = 5
RESPONSE_OVERHEAD_BYTES = 131072
SKILL_DIRECTORIES = (".agents/skills", ".claude/skills")
PROJECT_FILES = (
    "README", "README.md", "README.rst", "README.txt", "AGENTS.md", "package.json",
    "pyproject.toml", "Cargo.toml", "go.mod", "Makefile", "CMakeLists.txt",
    "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
    "justfile", "Taskfile.yml", "deno.json", "deno.jsonc",
)


def inside(path, root):
    """Compare normalized absolute paths without accepting sibling prefix collisions."""
    return os.path.commonpath((root, path)) == root


def workspace_root(value, cwd):
    """Canonicalize an existing directory before using it as a workspace boundary."""
    root = os.path.realpath(path_for(value, cwd))
    if not os.path.isdir(root):
        raise ValueError("Workspace root must be an existing directory: " + root)
    return root


def scoped_path(value, root):
    """Reject lexical traversal and resolved symlink escapes, including absent target files."""
    lexical = path_for(value, root)
    resolved = os.path.realpath(lexical)
    if not inside(lexical, root) or not inside(resolved, root):
        raise ValueError("Path is outside the workspace: " + value)
    return lexical, resolved


def directory_chain(path, root):
    """Return root-to-target ancestors; an absent target is interpreted as a new file."""
    directory = path if os.path.isdir(path) else os.path.dirname(path)
    chain = []
    while inside(directory, root):
        chain.append(directory)
        if directory == root:
            break
        directory = os.path.dirname(directory)
    return list(reversed(chain))


def context_directories(paths, root):
    """Include both alias and real ancestors so symlinks cannot hide applicable rules."""
    targets = []
    directories = []
    seen = set()
    for value in paths:
        lexical, resolved = scoped_path(value, root)
        for target in (lexical, resolved):
            if target not in targets:
                targets.append(target)
            for directory in directory_chain(target, root):
                ancestors = directory_chain(os.path.realpath(directory), root) + [directory]
                for ancestor in ancestors:
                    if ancestor in seen:
                        continue
                    if len(directories) == DIRECTORY_COUNT:
                        raise ValueError("Workspace context exceeds its directory budget; request fewer paths")
                    directories.append(ancestor)
                    seen.add(ancestor)
    return targets, directories


def instructions_for(directories, root, limit):
    """Read complete rules in ancestor order; unreadable or oversized guidance fails closed."""
    instructions = []
    scopes = list(dict.fromkeys(os.path.realpath(directory) for directory in directories))
    total = 0
    for scope in scopes:
        candidate = os.path.join(scope, "AGENTS.md")
        if not os.path.lexists(candidate):
            continue
        filename = os.path.realpath(candidate)
        if not inside(filename, root):
            raise ValueError("AGENTS.md resolves outside the workspace: " + candidate)
        try:
            data, _ = load_bytes(filename, min(limit, RULE_BYTES))
            content = text_from(data)
        except (OSError, ValueError, UnicodeError) as error:
            raise ValueError("Cannot load project instructions %s: %s" % (candidate, error)) from error
        total += len(data)
        if total > CONTEXT_BYTES:
            raise ValueError("Project instructions exceed the 128 KiB context budget; request fewer paths")
        instructions.append({"path": candidate, "scope": scope,
                             "sha256": digest(data), "content": content})
    # context_directories includes every ancestor. Send only the leaves of these
    # chains so a deep path does not repeat its entire prefix at every level.
    parents = {os.path.dirname(scope) for scope in scopes if scope != root}
    return instructions, total, [scope for scope in scopes if scope not in parents]


def bounded_entries(directory, warnings, limit=SCAN_ENTRIES):
    """Read one nonrecursive directory within a caller's remaining scan budget."""
    entries = []
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if len(entries) == limit:
                    warnings.append("Directory scan truncated after %d entries: %s" % (limit, directory))
                    break
                entries.append(entry.name)
    except FileNotFoundError:
        return []
    except OSError as error:
        warnings.append("Cannot scan %s: %s" % (directory, error))
        return []
    return sorted(entries)


def skill_metadata(filename, limit):
    """Read only bounded YAML frontmatter, leaving even a large skill body unloaded."""
    budget = min(limit, RULE_BYTES)
    descriptor = os.open(filename, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("Expected a regular SKILL.md file")
        data = handle.read(budget + 1)
    lines = data.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != b"---":
        raise ValueError("SKILL.md must start with YAML frontmatter")
    consumed = len(lines[0])
    for index, line in enumerate(lines[1:], 1):
        consumed += len(line)
        if line.rstrip() in (b"---", b"..."):
            if consumed <= budget:
                return text_from(b"".join(lines[1:index]))
            break
    raise ValueError("SKILL.md frontmatter is missing its closing delimiter or exceeds the byte budget")


def skill_roots(configured, root, warnings):
    """Resolve skill roots once per workspace, independent of inspected paths."""
    seen = set()
    for value in configured:
        candidate = path_for(value, root)
        directory = os.path.realpath(candidate)
        if directory in seen:
            continue
        if value in SKILL_DIRECTORIES and not inside(directory, root):
            warnings.append("Default skill directory resolves outside the workspace; configure it explicitly: " + candidate)
            continue
        seen.add(directory)
        yield directory


def skills_for(configured, root, limit, remaining, warnings):
    """Discover bounded metadata; report every incomplete catalog instead of hiding omissions."""
    skills = []
    scanned = 0
    seen = set()
    for directory in skill_roots(configured, root, warnings):
        for name in bounded_entries(directory, warnings, SCAN_ENTRIES - scanned):
            scanned += 1
            candidate = os.path.join(directory, name, "SKILL.md")
            if not os.path.lexists(candidate):
                continue
            filename = os.path.realpath(candidate)
            if not inside(filename, directory):
                warnings.append("Skill resolves outside its configured directory and was skipped: " + candidate)
                continue
            if filename in seen:
                continue
            if len(skills) == SKILL_COUNT:
                warnings.append("Skill catalog truncated after %d skills" % SKILL_COUNT)
                return skills
            try:
                content = skill_metadata(filename, limit)
            except (OSError, ValueError, UnicodeError) as error:
                warnings.append("Cannot load skill metadata %s: %s" % (candidate, error))
                continue
            size = len(content.encode("utf-8"))
            if size > remaining:
                warnings.append("Skill metadata truncated at the shared 128 KiB context budget")
                return skills
            remaining -= size
            seen.add(filename)
            skills.append({"path": filename, "scope": root, "content": content})
        if scanned == SCAN_ENTRIES:
            warnings.append("Skill discovery stopped at the %d-entry scan budget" % SCAN_ENTRIES)
            return skills
    return skills


def check_cancel(cancel_event):
    """Stop cooperative workspace work before starting another external inspection."""
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("Workspace request cancelled")


def git_command(root, arguments, limit, cancel_event=None, count_lines=False):
    """Inspect Git with bounded reads and a deadline, without a shell or inherited repository redirection."""
    check_cancel(cancel_event)
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    command = ["git", "-c", "core.fsmonitor=false", "-C", root] + arguments
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    preview = bytearray()
    lines = 0
    truncated = False
    deadline = time.monotonic() + GIT_TIMEOUT
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                check_cancel(cancel_event)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Git inspection timed out")
                if not selector.select(min(0.05, remaining)):
                    continue
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                remaining_bytes = limit - len(preview)
                preview.extend(chunk[:remaining_bytes])
                if len(chunk) > remaining_bytes:
                    truncated = True
                if count_lines:
                    # Short status quotes embedded newlines. Drain and count entries even
                    # after the preview fills, within the same deadline and memory budget.
                    lines += chunk.count(b"\n")
                elif truncated:
                    process.kill()
                    break
        while process.poll() is None:
            check_cancel(cancel_event)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Git inspection timed out")
            try:
                process.wait(timeout=min(0.05, remaining))
            except subprocess.TimeoutExpired:
                pass
        code = process.returncode
        return preview.decode("utf-8", "replace"), code, truncated, lines
    finally:
        # A Git wrapper can leave children alive even after its own process exits.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def git_status_arguments(root, warnings, cancel_event=None):
    """Disable content filters before automatic status can inspect tracked file bytes."""
    configured, code, truncated, _ = git_command(
        root, ["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process|required)$"],
        GIT_BYTES, cancel_event)
    if truncated or code not in (0, 1) or "\ufffd" in configured:
        raise ValueError("Cannot safely enumerate Git filters; automatic status was skipped")
    drivers = sorted({key.rsplit(".", 1)[0] for key in configured.split("\x00") if key})
    if any("=" in driver for driver in drivers):
        # Git's -c key=value syntax splits at the first '=', including subsection names.
        raise ValueError("Cannot safely disable Git filters with '=' in their names; automatic status was skipped")
    arguments = []
    for driver in drivers:
        arguments.extend(["-c", driver + ".clean=", "-c", driver + ".process=",
                          "-c", driver + ".required=false"])
    if drivers:
        warnings.append("Automatic Git status skipped configured clean/process filter normalization; "
                        "status may differ from normalized content. Explicit Git validation may be needed "
                        "after reviewing project instructions.")
    # One uncolored line per entry, even when the user's normal status includes a branch header or columns.
    return arguments + ["-c", "status.branch=false", "-c", "status.showStash=false", "-c", "column.status=never",
                        "-c", "color.status=false", "status", "--short", "--untracked-files=normal",
                        "--ignore-submodules=all", "--", "."]


def git_details(root, warnings, cancel_event=None):
    """Report repository identity and existing changes, warning on bounded inspection failures."""
    try:
        repository, code, truncated, _ = git_command(root, ["rev-parse", "--show-toplevel"], 8192, cancel_event)
        if code != 0:
            return None
        if truncated:
            raise ValueError("Git root exceeds the inspection byte budget")
        branch, branch_code, branch_truncated, _ = git_command(
            root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 8192, cancel_event)
        status_arguments = git_status_arguments(root, warnings, cancel_event)
        status, status_code, _, total = git_command(root, status_arguments, GIT_BYTES, cancel_event, count_lines=True)
        if status_code != 0:
            raise ValueError("Git status failed")
        if branch_truncated:
            warnings.append("Git branch name exceeded the inspection byte budget")
        # Drop the final fragment if the byte budget cut off a filename.
        entries = status.split("\n", GIT_STATUS_ENTRIES)[:-1]
        return {"root": repository.rstrip("\n"),
                "branch": branch.rstrip("\n") if branch_code == 0 and not branch_truncated else None,
                "status": "".join(entry + "\n" for entry in entries), "omitted": total - len(entries)}
    except InterruptedError:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        warnings.append("Cannot inspect Git state: " + str(error))
        return None


def project_files(directories, root, warnings):
    """Identify bounded project entry files without reading or executing their contents."""
    files = []
    seen = set()
    for directory in directories:
        for name in PROJECT_FILES:
            filename = os.path.realpath(os.path.join(directory, name))
            if filename in seen or not inside(filename, root) or not os.path.isfile(filename):
                continue
            if len(files) == PROJECT_COUNT:
                warnings.append("Project entry listing truncated after %d files" % PROJECT_COUNT)
                return files
            files.append(filename)
            seen.add(filename)
    return files


def workspace_context(request, opening=False):
    """Collect applicable rules; opening also discovers the root's project, skills, and Git state."""
    args = request.get("args", {})
    root = workspace_root(args["path"] if opening else args["root"], request["cwd"])
    if not opening and root != path_for(args["root"], request["cwd"]):
        raise ValueError("Workspace root changed; reopen the workspace before continuing")
    paths, directories = context_directories([root] if opening else args.get("paths", ["."]), root)
    warnings = []
    instructions, used, leaves = instructions_for(directories, root, request["maxFileBytes"])
    result = {"root": root, "paths": paths, "instructions": instructions, "rule_scope_leaves": leaves,
              "skill_files": [], "project_files": [], "git": None, "warnings": warnings}
    if opening:
        result["skill_files"] = skills_for(args.get("skillDirectories", SKILL_DIRECTORIES), root,
                                          request["maxFileBytes"], CONTEXT_BYTES - used, warnings)
        result["project_files"] = project_files(directories, root, warnings)
        result["git"] = git_details(root, warnings, request.get("_cancel_event"))
    return result


def skill_resources(directory, warnings):
    """List bounded immediate resources and standard resource subdirectories within the skill."""
    resources = []
    scanned = 0
    directories = [directory] + [os.path.join(directory, name) for name in ("references", "scripts", "assets")]
    for current in directories:
        if not inside(os.path.realpath(current), directory):
            warnings.append("Skill resource directory resolves outside the skill and was skipped: " + current)
            continue
        for name in bounded_entries(current, warnings, SCAN_ENTRIES - scanned):
            scanned += 1
            candidate = os.path.join(current, name)
            filename = os.path.realpath(candidate)
            if not inside(filename, directory):
                warnings.append("Skill resource resolves outside the skill and was skipped: " + candidate)
                continue
            if not os.path.isfile(filename):
                continue
            if len(resources) == RESOURCE_COUNT:
                warnings.append("Skill resource listing truncated after %d files" % RESOURCE_COUNT)
                return resources
            resources.append(os.path.relpath(candidate, directory))
        if scanned == SCAN_ENTRIES:
            warnings.append("Skill resource discovery stopped at the %d-entry scan budget" % SCAN_ENTRIES)
            break
    return resources


def read_skill(request):
    """Read one registered skill resource without rebasing replaced directories or allowing traversal."""
    args = request.get("args", {})
    directory = os.path.abspath(os.path.dirname(args["path"]))
    resource = args.get("resource", "SKILL.md")
    if os.path.isabs(resource) or ".." in resource.split(os.sep):
        raise ValueError("Skill resource must be a relative path without parent traversal")
    filename = os.path.realpath(os.path.join(directory, resource))
    if not inside(filename, directory):
        raise ValueError("Skill resource resolves outside its skill directory")
    data, _ = load_bytes(filename, min(request["maxFileBytes"], CONTEXT_BYTES))
    warnings = []
    return {"path": filename, "directory": directory, "content": text_from(data), "sha256": digest(data),
            "resources": skill_resources(directory, warnings), "warnings": warnings}


def dispatch(request):
    """Route workspace requests through the worker's standard result and error protocol."""
    check_cancel(request.get("_cancel_event"))
    operation = request["op"]
    if operation == "workspace_open":
        result = workspace_context(request, opening=True)
    elif operation == "workspace_context":
        result = workspace_context(request)
    elif operation == "workspace_skill_read":
        result = read_skill(request)
    else:
        raise ValueError("Unsupported workspace operation: " + operation)
    check_cancel(request.get("_cancel_event"))

    # Match the worker's actual encoding, including escaped controls and all metadata paths.
    encoded = json.dumps({"ok": True, "result": result}, ensure_ascii=False).encode("utf-8", "backslashreplace")
    if len(encoded) + 1 > request["maxFileBytes"] * 6 + RESPONSE_OVERHEAD_BYTES:
        raise ValueError("Workspace response exceeds the transport byte budget; "
                         "request fewer paths or skill_directories, or increase maxFileBytes")
    return result
