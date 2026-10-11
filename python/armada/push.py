"""A project's tasks: `python -m armada push` finds the project above cwd by its pyproject.toml's
[tool.armada] table, bundles every task its folders export into a deterministic zipapp the container runs
with `python3`, uploads it by its digest, and records each task's id against it. Inside a project, `.map`,
`.stream` and `.run` push first when the folder changed, once per process per deployment, like pushed() in
push.ts."""

import ast
import importlib
import io
import os
import sys
import threading
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import Armada

CONFIG_FILE = "pyproject.toml"


class PushError(Exception):
    pass


@dataclass(frozen=True)
class Project:
    """A project's root and its [tool.armada] config."""

    root: Path
    slug: str
    tasks: list[str]


@dataclass(frozen=True)
class Pushed:
    """What a push recorded on the deployment."""

    project: str
    bundle: str
    ids: list[str]
    runtime: str


def find_project(here: str | None = None) -> Project | None:
    """The project above `here`: its root and [tool.armada] config (`project`, `tasks`), or None outside one."""
    directory = Path(here or os.getcwd()).resolve()
    while True:
        file = directory / CONFIG_FILE
        if file.exists():
            table = tomllib.loads(file.read_text()).get("tool", {}).get("armada", {})
            if "project" in table:
                return Project(directory, str(table["project"]), [str(each) for each in table.get("tasks", ["tasks"])])
        if directory.parent == directory:
            return None
        directory = directory.parent


def _dotted(root: Path, path: Path) -> str:
    """`path`'s module name under `root`: `tasks/jobs.py` is `tasks.jobs`, `tasks/__init__.py` is `tasks`."""
    return str(path.relative_to(root).with_suffix("")).replace(os.sep, ".").removesuffix(".__init__")


def _imports(root: Path, name: str, path: Path) -> list[Path]:
    """The project modules `path` (module `name`) names in any `import` or `from`, a function body's included: a
    task may import its helpers only when it runs, which no import at discovery loads."""
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    named: list[str] = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            named += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level > 0:
                parts = package.split(".") if package else []
                base = ".".join(parts[: len(parts) - node.level + 1] + ([base] if base else []))
            named += [base] + [f"{base}.{alias.name}" for alias in node.names]
    found: list[Path] = []
    for each in named:
        parts = [part for part in each.split(".") if part]
        for depth in range(1, len(parts) + 1):
            here = root.joinpath(*parts[:depth])
            found.extend(hit.resolve() for hit in (here.with_suffix(".py"), here / "__init__.py") if hit.is_file())
    return found


def _task_files(root: Path, folders: list[str]) -> tuple[list[Path], list[str], dict[str, Path]]:
    """Every task the project's folders export, each by the file it is in, refusing an id two tasks share, and every
    project module they need. Each file is imported under its own name, as the bundle imports it, so its relative
    imports resolve; the modules that loads, and those any of them names in an import, are what it needs. The import
    is fresh, from the files as they are now, and leaves this process's modules as it found them."""
    from .task import Task

    tops = {Path(folder).parts[0] for folder in folders}
    # The SDK's own package name: a task folder of that name would shadow it here and in the container.
    if __package__ in tops:
        raise PushError(f"a task folder may not be named {__package__}, the SDK's package: rename it and its [tool.armada] tasks entry")
    # The project's own top-level names, less the standard library's and the SDK's, which it cannot shadow here.
    names = {child.stem for child in root.glob("*.py")}
    names |= {child.name for child in root.iterdir() if child.is_dir() and child.name.isidentifier()}
    names -= set(sys.stdlib_module_names) | {__package__ or ""}
    ours = [name for name in sys.modules if name.split(".")[0] in names]
    kept = {name: sys.modules.pop(name) for name in ours}

    files: list[Path] = []
    owners: dict[str, tuple[Task[Any, Any], Path]] = {}
    sys.path.insert(0, str(root))
    try:
        for folder in folders:
            for path in sorted((root / folder).rglob("*.py")):
                if path.name.startswith("test_") or path.name.endswith(".test.py"):
                    continue
                module = importlib.import_module(_dotted(root, path))
                tasks = [value for value in vars(module).values() if isinstance(value, Task)]
                for value in tasks:
                    held = owners.get(value.id)
                    # One task under two names is one task; two tasks of one id are not, in one file or two.
                    if held is not None and held[0] is not value:
                        raise PushError(f"two tasks have the id {value.id}: in {held[1]} and {path}")
                    owners[value.id] = (value, path)
                if tasks:
                    files.append(path)
        loaded = {
            name: Path(source).resolve()
            for name, module in sys.modules.items()
            if isinstance(source := getattr(module, "__file__", None), str)
            and source.endswith(".py")
            and Path(source).resolve().is_relative_to(root)
        }
    finally:
        sys.path.remove(str(root))
        for name in [name for name in sys.modules if name.split(".")[0] in names]:
            del sys.modules[name]
        sys.modules.update(kept)

    if not owners:
        raise PushError(f"no task is exported from {', '.join(folders)} under {root}")
    modules: dict[str, Path] = {}
    queue = list(loaded.values())
    while queue:
        path = queue.pop()
        name = _dotted(root, path)
        if name not in modules:
            modules[name] = path
            queue += _imports(root, name, path)
    return files, sorted(owners), modules


def bundle_tasks(root: Path, folders: list[str]) -> tuple[bytes, list[str]]:
    """The project's task files bundled as a zipapp (`python3 bundle.pyz` runs its `__main__.py`): the runner,
    the armada package's runtime modules, the task folders' modules and every project module they import.
    Sorted entries, fixed timestamps and modes: the same sources give the same digest."""
    root = root.resolve()
    files, ids, modules = _task_files(root, folders)
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
        for _name, path in sorted(modules.items()):
            inside = str(path.relative_to(root))
            # zipimport needs each directory a regular package: an empty __init__.py where the project has none.
            for depth in range(1, inside.count("/") + 1):
                folder = inside.rsplit("/", depth)[0]
                if folder not in packaged:
                    packaged.add(folder)
                    if not (root / folder / "__init__.py").exists():
                        add(f"{folder}/__init__.py", b"")
            add(inside, path.read_bytes())
        names = sorted(_dotted(root, path) for path in files)
        entry = (
            "import importlib\n"
            "from armada.runner import run_tasks\n"
            f"run_tasks([importlib.import_module(name) for name in {names!r}])\n"
        )
        add("__main__.py", entry.encode())

    return archive.getvalue(), ids


def push(armada: Armada, here: str | None = None) -> Pushed | None:
    """Pushes the project above `here`: its bundle, then its ids against it. None outside a project."""
    found = find_project(here)
    if found is None:
        return None
    content, ids = bundle_tasks(found.root, found.tasks)
    record = Pushed(found.slug, armada.upload_bundle(content), ids, "python")
    armada.post("/tasks", {"project": record.project, "bundle": record.bundle, "ids": record.ids, "runtime": record.runtime})

    return record


# Each push from this process, by the deployment's URL and the directory whose project it pushed.
_pushes: dict[str, str | None] = {}
_lock = threading.Lock()


def pushed(armada: Armada) -> str | None:
    """The bundle this process pushed for the project it runs in, or None outside a project."""
    key = f"{armada.connection.url} {os.getcwd()}"
    with _lock:
        if key not in _pushes:
            record = push(armada, os.getcwd())
            _pushes[key] = record.bundle if record is not None else None
    return _pushes[key]
