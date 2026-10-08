"""Runs every task against the deployment ARMADA_CONNECTION names: `python3 run.py`."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tasks.jobs import even, flake, keeper, png, seen, shout, square, whoami  # noqa: E402

print("map:", square.map([1, 2, 3]))
print("run:", square.run(9))
print("local:", square.local(5))

job = shout.stream(w for w in ["a", "b", "c"])
for result in job:
    print("stream:", result.index, result.value if result.ok else result.error)

print("bytes:", png.run(65))
try:
    even.map([2, 3, 4])
except Exception as failed:
    print("validator:", failed)

print("secret:", whoami.run(0))
made = keeper.run(1)
print("artifacts:", made)
print("retry:", flake.run(0))
print("cache first:", seen.map([10])[0])
print("cache again:", seen.run(10))
