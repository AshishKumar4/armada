"""The armada Python SDK: `task` defines a task, `recipe` its environment, `sh` a command a body may return,
`connect` the deployment. `python -m armada push` sends a project's task folder; `.map`, `.stream`, `.run` and
`.local` run a task by its id."""

from .client import Armada, Connection, RequestError, connect, summary_of
from .recipe import RecipeBuilder, debian, from_, recipe
from .sh import Completed, OutFile, Shell, ShellError, out_file, quote, raw, sh
from .task import Context, Job, MapError, Meta, RemoteError, Result, SchemaError, Task, task

__all__ = [
    "Armada", "Completed", "Connection", "Context", "Job", "MapError", "Meta", "OutFile", "RecipeBuilder",
    "RemoteError", "RequestError", "Result", "SchemaError", "Shell", "ShellError", "Task",
    "connect", "debian", "from_", "out_file", "quote", "raw", "recipe", "sh", "summary_of", "task",
]
