"""`python -m armada push`: bundles the project above cwd's tasks and records them on the deployment."""

import sys

from .client import connect
from .push import push


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] != "push":
        print("usage: python -m armada push", file=sys.stderr)
        sys.exit(2)
    record = push(connect())
    if record is None:
        print("armada: no [tool.armada] project found above here", file=sys.stderr)
        sys.exit(1)
    print(f"pushed {len(record['ids'])} tasks ({', '.join(record['ids'])}) as {record['bundle'][:12]}…")


if __name__ == "__main__":
    main()
