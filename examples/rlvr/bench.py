"""Grades one GRPO step's samples with the unit-test reward on armada: `python3 bench.py 256 8 map 256`, for 256 MBPP
problems, 8 samples each, on up to 256 containers. `stream` in place of `map` reads each reward as it lands and says
when each problem's group is whole, as an async trainer would; `local` grades them here, one after another.

The samples stand in for a policy's. Each problem gets its reference solution twice, once slowed by a second, and five
broken copies: one answering None, one raising, one looping, one exiting 0 before its tests run, and an empty one."""

import ast
import json
import sys
import time
import urllib.request
import warnings
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tasks.reward import Sample, unit_tests

ROWS = "https://datasets-server.huggingface.co/rows?dataset=google-research-datasets%2Fmbpp&config=sanitized&split=test"

# How each sample of a group is made from the reference solution `code`, whose tested function is `name`.
KINDS = {
    "right": lambda code, name: code,
    "right again": lambda code, name: code,
    "slow": lambda code, name: f"import time\ntime.sleep(1)\n{code}",
    "wrong": lambda code, name: f"{code}\ndef {name}(*args, **kwargs):\n    return None",
    "raises": lambda code, name: f"{code}\ndef {name}(*args, **kwargs):\n    raise ValueError(args)",
    "loops": lambda code, name: f"{code}\ndef {name}(*args, **kwargs):\n    while True:\n        pass",
    "exits early": lambda code, name: f"import os\nos._exit(0)\n{code}",
    "empty": lambda code, name: "",
}


def problems(count: int) -> list[dict[str, object]]:
    """The first `count` problems of MBPP's sanitized test split."""
    rows: list[dict[str, object]] = []
    while len(rows) < count:
        with urllib.request.urlopen(f"{ROWS}&offset={len(rows)}&length={min(100, count - len(rows))}") as answer:
            page = json.load(answer)["rows"]
        if not page:
            break
        rows += [entry["row"] for entry in page]
    return rows


def tested(code: str, test: str) -> str:
    """The function of `code` that `test` calls. Some solutions' regexes are strings with escapes Python warns of."""
    with warnings.catch_warnings(action="ignore", category=SyntaxWarning):
        defined = {node.name for node in ast.walk(ast.parse(code)) if isinstance(node, ast.FunctionDef)}
    called = [node.func.id for node in ast.walk(ast.parse(test)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
    return next(name for name in called if name in defined)


def main() -> None:
    count, group = int(sys.argv[1]), int(sys.argv[2])
    mode = sys.argv[3] if len(sys.argv) > 3 else "map"
    pool = int(sys.argv[4]) if len(sys.argv) > 4 else None
    kinds = list(KINDS)[:group]
    samples: list[Sample] = []
    labels: list[tuple[int, str]] = []
    for number, row in enumerate(problems(count)):
        code, tests = "\n".join([*row["test_imports"], str(row["code"])]), list(row["test_list"])
        name = tested(str(row["code"]), tests[0])
        for kind in kinds:
            samples.append({"program": KINDS[kind](code, name), "tests": tests})
            labels.append((number, kind))

    started = time.monotonic()
    rewards: dict[int, float] = {}
    work = 0.0
    if mode == "local":
        rewards = {index: unit_tests.local(sample) for index, sample in enumerate(samples)}
    else:
        job = unit_tests.stream(samples, pool=pool)
        landed: dict[int, list[float]] = defaultdict(list)
        whole: list[float] = []
        for result in job:
            rewards[result.index] = result.value if result.ok else float("nan")
            work += result.meta.seconds
            problem = labels[result.index][0]
            landed[problem].append(rewards[result.index])
            if len(landed[problem]) == len(kinds):
                whole.append(time.monotonic() - started)
        if mode == "stream":
            print(f"groups whole: the first at {whole[0]:.1f} s, half at {whole[len(whole) // 2]:.1f} s, the last at {whole[-1]:.1f} s")
        print(f"{job.summary().vessels} containers, {work:.0f} s of grading in all")
    took = time.monotonic() - started

    by_kind: dict[str, list[float]] = defaultdict(list)
    for index, reward in rewards.items():
        by_kind[labels[index][1]].append(reward)
    print(f"{len(samples)} samples of {count} problems graded in {took:.1f} s")
    for kind in kinds:
        print(f"  {kind:12} mean reward {sum(by_kind[kind]) / len(by_kind[kind]):.3f}  {dict(Counter(by_kind[kind]))}")


if __name__ == "__main__":
    main()
