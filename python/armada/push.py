"""A project's tasks: `python -m armada push` finds the project above cwd by its pyproject.toml's
[tool.armada] table, bundles every task its folders export into a deterministic zipapp the container runs
with `python3`, uploads it by its digest, and records each task's id against it. Inside a project, `.map`,
`.stream` and `.run` push first when the folder changed, once per process per deployment, like pushed() in
push.ts."""

import ast
import io
import os
import sys
import threading
import tomllib
import zipfile
from pathlib import Path
from typing import Any, Optional

from .client import Armada, connect

CONFIG_FILE = "pyproject.toml"


class PushError(Exception):
    pass


def find_project(here: Optional[str] = None) -> Optional[tuple[Path, dict[str, Any]]]:
    """The project above `here`: its root and [tool.armada] config (`project`, `tasks`), or None outside one."""
    directory = Path(here or os.getcwd()).resolve()
    while True:
        file = directory / CONFIG_FILE
        if file.exists():
            table = tomllib.loads(file.read_text()).get("tool", {}).get("armada", {})
            if "project" in table:
                return directory, {"project": table["project"], "tasks": list(table.get("tasks", ["armada"]))}
        if directory.parent == directory:
            return None
        directory = directory.parent


def _is_task(value: object) -> bool:
    from .task import Task

    return isinstance(value, Task)


def _task_files(root: Path, folders: list[str]) -> tuple[list[Path], list[str]]:
    """Every task the project's folders export, each by the file it is in, refusing an id two of them share."""
    files: list[Path] = []
    owners: dict[str, Path] = {}

    for folder in folders:
        for path in sorted((root / folder).rglob("*.py")):
            if path.name.endswith((".test.py",)) or path.name.startswith("test_"):
                continue
            tree = ast.parse(path.read_text())
            top = [node.targets[0].id for node in tree.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)]
            decorated = [node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.decorator_list]
            if not top and not decorated:
                continue
            sys.path.insert(0, str(root))
            try:
                import importlib.util

                spec = importlib.util.spec_from_file_location(f"_armada_scan_{path.stem}_{abs(hash(path))}", path)
                module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
                spec.loader.exec_module(module)  # type: ignore[union-attr]
                for name, value in vars(module).items():
                    if _is_task(value):
                        if value.id in owners:
                            raise PushError(f"two tasks have the id {value.id}: in {owners[value.id]} and {path}")
                        owners[value.id] = path
            finally:
                sys.path.remove(str(root))
            if any(_is_task(value) for value in vars(module).values()):
                files.append(path)

    if not owners:
        raise PushError(f"no task is exported from {', '.join(folders)} under {root}")
    return files, sorted(owners)


def _module_paths(root: Path, files: list[Path]) -> dict[str, Path]:
    """The task files plus every project-root module they import: the `import`/`from` names in each file that
    resolve under the root, transitively. Third-party packages come from the recipe's install step, never the
    bundle."""
    found: dict[str, Path] = {}
    queue = list(files)
    while queue:
        file = queue.pop()
        key = str(file.relative_to(root)).removesuffix(".py").replace(os.sep, ".")
        if key in found:
            continue
        found[key] = file
        tree = ast.parse(file.read_text())
        package = key.rpartition(".")[0]
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module is not None:
                    names = [node.module]
                elif node.level > 0:
                    # `from .. import x`: the package `level` steps up from the file's own.
                    base = package.split(".")[: max(0, len(package.split(".")) - node.level + 1)]
                    names = [".".join(base + ([node.module] if node.module else []))]
            for name in names:
                for depth in range(len(name.split(".")), 0, -1):
                    prefix = name.split(".")[:depth]
                    candidate = root.joinpath(*prefix).with_suffix(".py")
                    package_init = root.joinpath(*prefix) / "__init__.py"
                    hit = candidate if candidate.exists() else (package_init if package_init.exists() else None)
                    if hit is not None and hit.resolve().is_relative_to(root):
                        module_name = ".".join(prefix) if hit == candidate else ".".join(prefix)
                        resolved = hit.resolve()
                        if str(resolved.relative_to(root)).removesuffix(".py").replace(os.sep, ".") not in found:
                            queue.append(resolved)
                        break
    return found


def bundle_tasks(root: Path, folders: list[str]) -> tuple[bytes, list[str]]:
    """The project's task files bundled as a zipapp (`python3 bundle.pyz` runs its `__main__.py`): the runner,
    the armada package's runtime modules, the task folders' modules and every project module they import.
    Sorted entries, fixed timestamps and modes: the same sources give the same digest."""
    files, ids = _task_files(root, folders)
    modules = _module_paths(root, files)
    archive = io.BytesIO()
    # ZIP64 fields carry no timestamp; DOS epoch 1980-01-01 is the fixed date.
    fixed = (1980, 1, 1, 0, 0, 0)

    def add(info_name: str, content: bytes) -> None:
        info = zipfile.ZipInfo(info_name, date_time=fixed)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        zipping.writestr(info, content)

    with zipfile.ZipFile(archive, "w") as zipping:
        package = Path(__file__).parent
        for module in sorted(package.glob("*.py")):
            add(f"armada/{module.name}", module.read_bytes())
        marker = Path(__file__).parent / "py.typed"
        if marker.exists():
            add("armada/py.typed", marker.read_bytes())
        packaged: set[str] = set()
        for name, path in sorted(modules.items()):
            inside = str(path.relative_to(root))
            # zipimport needs each directory a regular package: an empty __init__.py where the project has none.
            for depth in range(1, inside.count("/") + 1):
                package = inside.rsplit("/", depth)[0]
                if package not in packaged:
                    packaged.add(package)
                    if not (root / package / "__init__.py").exists():
                        add(f"{package}/__init__.py", b"")
            add(inside, path.read_bytes())
        names = sorted(str(path.relative_to(root)).removesuffix(".py").replace(os.sep, ".") for path in files)
        entry = (
            "import importlib\n"
            "from armada.runner import run_tasks\n"
            f"run_tasks([importlib.import_module(name) for name in {names!r}])\n"
        )
        add("__main__.py", entry.encode())

    return archive.getvalue(), ids


def push(armada: Armada, here: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Pushes the project above `here`: its bundle, then its ids against it. None outside a project."""
    found = find_project(here)
    if found is None:
        return None
    root, config = found
    content, ids = bundle_tasks(root, config["tasks"])
    record = {"project": config["project"], "bundle": armada.upload_bundle(content), "ids": ids, "runtime": "python"}
    armada.post("/tasks", record)

    return record


# Each push from this process, by the deployment's URL and the directory whose project it pushed.
_pushes: dict[str, Optional[str]] = {}
_lock = threading.Lock()


def pushed(armada: Armada) -> Optional[str]:
    """The bundle this process pushed for the project it runs in, or None outside a project."""
    key = f"{armada.connection.url} {os.getcwd()}"
    with _lock:
        if key not in _pushes:
            record = push(armada, os.getcwd())
            _pushes[key] = record["bundle"] if record is not None else None
    return _pushes[key]
