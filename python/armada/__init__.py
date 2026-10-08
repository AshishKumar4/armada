"""The armada Python SDK: `task` defines a task, `recipe` its environment, `sh` a command a body may return,
`connect` the deployment. `python -m armada push` sends a project's task folder; `.map`, `.stream`, `.run` and
`.local` run a task by its id."""

from .client import Armada, Connection, RequestError, connect, summary_of
from .recipe import RecipeBuilder, debian, from_, recipe
from .sh import Completed, OutFile, Shell, ShellError, out_file, quote, raw, sh
from .client import JobStatus, Summary, TaskCounts, Vessel
from .task import (Cancelled, Context, Errored, Job, Lost, MapError, Meta, Ok, RemoteError, Result, SchemaError,
                   Task, TimedOut, Validator, task)

__all__ = [
    "Armada", "Completed", "Connection", "Context", "Job", "MapError", "Meta", "OutFile", "RecipeBuilder",
    "Cancelled", "Errored", "JobStatus", "Lost", "Ok", "RemoteError", "RequestError", "Result", "SchemaError",
    "Shell", "ShellError", "Summary", "Task", "TaskCounts", "TimedOut", "Validator", "Vessel",
    "connect", "debian", "from_", "out_file", "quote", "raw", "recipe", "sh", "summary_of", "task",
]
