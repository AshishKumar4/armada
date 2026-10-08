"""The wire's constants, shared by the client, the pusher and the in-container runner — the same values
protocol.ts holds, so a Python task and a TypeScript one speak the same bytes."""

import hashlib
import json
from typing import Dict, List, Mapping, Optional, Union

# A JSON value, as protocol.ts's `Json` — what items and envelopes carry.
Json = Union[str, float, int, bool, None, List["Json"], Dict[str, "Json"]]

JsonObject = Dict[str, Json]


def object_of(value: Json) -> JsonObject:
    """`value` as a JSON object, or an empty one when the wire sent something else."""
    return value if isinstance(value, dict) else {}


def text_of(fields: Mapping[str, Json], key: str, default: str = "") -> str:
    value = fields.get(key)
    return value if isinstance(value, str) else default


def maybe_number_of(fields: Mapping[str, Json], key: str) -> Optional[float]:
    """A JSON number's value; a boolean, which Python counts as an int, is none."""
    value = fields.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def number_of(fields: Mapping[str, Json], key: str, default: float) -> float:
    value = maybe_number_of(fields, key)
    return default if value is None else value

# The wire's version, which every request names in PROTOCOL_HEADER.
PROTOCOL = 7

PROTOCOL_HEADER = "armada-protocol"

# Where a task's container keeps what armada gives it: the job's files, the pushed tasks' bundle,
# the file a task writes its output to, and the file the runner says there which kind of answer that is.
FILES_DIR = "/armada/files"
OUT_PATH = "/armada/task/out"
ANSWER_PATH = "/armada/task/answer"
ARTIFACTS_PATH = "/armada/task/artifacts"

# The container driver the environment key counts.
DRIVER = 2

# The container sizes, smallest first, each a Cloudflare instance type.
SIZES = {
    "micro": {"instance": "standard-1", "vcpus": 0.5, "memoryGiB": 4},
    "mini": {"instance": "standard-2", "vcpus": 1, "memoryGiB": 6},
    "small": {"instance": "standard-3", "vcpus": 2, "memoryGiB": 8},
    "medium": {"instance": "standard-4", "vcpus": 4, "memoryGiB": 12},
}

DEFAULT_BASE = "cloudflare/debian-trixie"


def environment_key(recipe: dict[str, object]) -> str:
    """A recipe's environment key: the same sha-256 protocol.ts's environmentKey takes of the same inputs,
    so a recipe built in Python hashes to the environment a TypeScript recipe builds."""
    instance = SIZES[str(recipe.get("size", "medium"))]["instance"]
    repo = recipe.get("repo")
    inputs = [DRIVER, recipe.get("base", DEFAULT_BASE), recipe.get("setup", ""), recipe.get("install", ""), instance, repo]

    return hashlib.sha256(json.dumps(inputs, separators=(",", ":")).encode()).hexdigest()


def remote_error(cause: BaseException) -> dict[str, str]:
    """A thrown error as an envelope carries it: its name, message and stack, for a retry named by the name."""
    import traceback

    return {"name": type(cause).__name__, "message": str(cause), "stack": "".join(traceback.format_exception(cause))}
