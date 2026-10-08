"""What a pushed task's bundle runs in a container — the Python twin of runner.ts: the task `ARMADA_TASK`
names, on the item in `ARMADA_ITEM`. A body that returns a value or throws is answered with an envelope in
`ARMADA_OUT`; a body that returns `sh` is a command, which runs here and writes `ARMADA_OUT` itself.
`ARMADA_ANSWER` says which — `value` (plus the error's name on its second line), or `command`."""

import json
import os
import signal
import sys
import threading
from types import ModuleType
from types import FrameType
from typing import Optional

from .sh import Shell, execute, out_file
from .task import Context, Task
from .wire import ARTIFACTS_PATH, FILES_DIR, OUT_PATH, ANSWER_PATH


def run_tasks(modules: list[ModuleType]) -> "None":
    """Runs the task ARMADA_TASK names among `modules`' exports, and exits: 1 when its body threw, a command's
    own exit code, so the job counts each red."""
    task_id = os.environ.get("ARMADA_TASK", "")
    found = next(
        (value for module in modules for value in vars(module).values() if isinstance(value, Task) and value.id == task_id),
        None,
    )
    if found is None:
        print(f"armada: no task {task_id} in this bundle", file=sys.stderr)
        sys.exit(1)
    stopped = threading.Event()

    def terminate(_signum: int, _frame: Optional[FrameType]) -> None:
        stopped.set()

    signal.signal(signal.SIGTERM, terminate)
    out = os.environ.get("ARMADA_OUT", OUT_PATH)
    missing = next((name for name in found.secrets if name not in os.environ), None)
    if missing is not None:
        print(f"armada: the secret {missing} was deleted; set it again with armada secret set {missing}", file=sys.stderr)
        sys.exit(1)
    context = Context(
        index=int(os.environ.get("ARMADA_INDEX", "0")),
        attempt=int(os.environ.get("ARMADA_ATTEMPT", "1")),
        stopped=stopped,
        out=out_file(out),
        files=os.environ.get("ARMADA_FILES", FILES_DIR),
        artifacts=os.environ.get("ARMADA_ARTIFACTS", ARTIFACTS_PATH),
        secrets={name: os.environ[name] for name in found.secrets},
    )
    answer = found.run_envelope(json.loads(os.environ.get("ARMADA_ITEM", "null")), context)
    marker = os.environ.get("ARMADA_ANSWER", ANSWER_PATH)

    if isinstance(answer, Shell):
        with open(marker, "w") as file:
            file.write("command")
        sys.exit(execute(answer.script).exit_code)
    # The error's name follows, for the job to decide a retry by.
    with open(marker, "w") as file:
        file.write("value" if answer.error is None else f"value\n{answer.error}")
    with open(out, "w") as file:
        file.write(json.dumps(answer.body, separators=(",", ":")))
    sys.exit(0 if answer.error is None else 1)
