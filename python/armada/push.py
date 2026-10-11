"""A project's tasks: `python -m armada push` finds the project above cwd by its pyproject.toml's
[tool.armada] table, bundles every task its folders export into a deterministic zipapp the container runs
with `python3`, uploads it by its digest, and records each task's id against it. Inside a project, `.map`,
`.stream` and `.run` push first when the folder changed, once per process per deployment, like pushed() in
push.ts."""

import importlib
import io
import os
import sys
import threading
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path

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


def _is_task(value: object) -> bool:
    from .task import Task

    return isinstance(value, Task)


def _dotted(root: Path, path: Path) -> str:
    """`path`'s module name under `root`: `tasks/jobs.py` is `tasks.jobs`, `tasks/__init__.py` is `tasks`."""
    return str(path.relative_to(root).with_suffix("")).replace(os.sep, ".").removesuffix(".__init__")


def _project_modules(root: Path) -> dict[str, Path]:
    """The project's modules this process has imported, by name: those under `root`, from source."""
    found: dict[str, Path] = {}
    for name, module in list(sys.modules.items()):
        source = getattr(module, "__file__", None)
        path = Path(source).resolve() if isinstance(source, str) else None
        if path is not None and path.suffix == ".py" and path.is_relative_to(root):
            found[name] = path
    return found


def _task_files(root: Path, folders: list[str]) -> tuple[list[Path], list[str], dict[str, Path]]:
    """Every task the project's folders export, each by the file it is in, refusing an id two of them share, and the
    project's modules their import loaded. Each file is imported under its own name, as the bundle imports it, so its
    relative imports resolve, and Python's own import system decides what it needs: a from-list's submodule and each
    package's `__init__.py` included."""
    files: list[Path] = []
    owners: dict[str, Path] = {}
    tops = {Path(folder).parts[0] for folder in folders}
    # The SDK's own package name: a task folder of that name would shadow it here and in the container.
    if __package__ in tops:
        raise PushError(f"a task folder may not be named {__package__}, the SDK's package: rename it and its [tool.armada] tasks entry")
    # A module of a task folder's name imported from elsewhere (another project, or a namespace package that has no
    # file) is not this one's: Python would import that one again.
    for name in [name for name in sys.modules if name.split(".")[0] in tops]:
        source = getattr(sys.modules[name], "__file__", None)
        if not (isinstance(source, str) and Path(source).resolve().is_relative_to(root)):
            del sys.modules[name]

    sys.path.insert(0, str(root))
    try:
        for folder in folders:
            for path in sorted((root / folder).rglob("*.py")):
                if path.name.startswith("test_") or path.name == "__init__.py":
                    continue
                module = importlib.import_module(_dotted(root, path))
                tasks = [value for value in vars(module).values() if _is_task(value)]
                for value in tasks:
                    if value.id in owners and owners[value.id] != path:
                        raise PushError(f"two tasks have the id {value.id}: in {owners[value.id]} and {path}")
                    owners[value.id] = path
                if tasks:
                    files.append(path)
    finally:
        sys.path.remove(str(root))

    if not owners:
        raise PushError(f"no task is exported from {', '.join(folders)} under {root}")
    return files, sorted(owners), _project_modules(root)


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
