"""The reward for code RL: the share of a problem's unit tests a sampled program passes. Each test runs in a process of
its own, and the program has BUDGET_S for all of them, so one that loops, crashes or exits early earns nothing for it.

It is no sandbox for hostile code. The pass token is in the program's own process, where code that looks for it can
find it, and packed tasks share a container as one user. A policy that learns to attack its grader needs one that runs
each test out of the program's reach."""

import secrets
import subprocess
import sys
import time
from typing import TypedDict

from armada import Context, recipe, task

# Seconds a program has for all of its tests.
BUDGET_S = 10


class Sample(TypedDict):
    """A sampled program and the asserts that grade it."""

    program: str
    tests: list[str]


@task(id="unit-tests", recipe=recipe.debian().size("micro"), timeout=60)
def unit_tests(sample: Sample, ctx: Context) -> float:
    passed = 0
    deadline = time.monotonic() + BUDGET_S
    for test in sample["tests"]:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        # Printed once the assert has passed: a program that exits 0 before it passes nothing.
        token = secrets.token_hex(8)
        source = f"{sample['program']}\n{test}\nprint({token!r})\n"
        try:
            ran = subprocess.run([sys.executable, "-"], input=source, capture_output=True, text=True, timeout=left)
        except subprocess.TimeoutExpired:
            break
        passed += ran.returncode == 0 and ran.stdout.rstrip().endswith(token)
    return passed / len(sample["tests"])
