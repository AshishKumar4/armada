"""The Python SDK's unit tests: quoting, recipe/env-key parity, envelope shapes, bundle determinism, config
discovery, the client against a fake Worker, the MapError/Result shapes and the submission's batches."""

import base64
import http.server
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from armada import Armada, Connection, Context, RequestError, SchemaError, ShellError, out_file, sh, task
from armada.push import PushError, bundle_tasks, find_project
from armada.task import Envelope, RemoteError, _Value


class TestSh(unittest.TestCase):
    def test_refuses_an_interpolation_inside_quotes(self) -> None:
        with self.assertRaises(ValueError):
            sh('echo "{}"', "word")

    def test_hands_each_word_to_the_program_unchanged(self) -> None:
        words = ["name\n", "a b", "it's", "$(echo pwned)"]
        self.assertEqual(sh("printf '[%s]' {}", words).text(), "".join(f"[{word}]" for word in words))

    def test_runs_and_reads(self) -> None:
        self.assertEqual(sh("echo hi").text(), "hi\n")
        with self.assertRaises(ShellError) as raised:
            sh("echo bad >&2; exit 3").run()
        self.assertEqual(raised.exception.exit_code, 3)
        self.assertIn("bad", str(raised.exception))


def _ctx() -> Context:
    return Context(0, 1, threading.Event(), out_file("/tmp/armada-test-out"), "/tmp", "/tmp", {})


class TestEnvelope(unittest.TestCase):
    def test_value_and_error_round_trip_through_the_wire_shapes(self) -> None:
        @task(id="square")
        def square(n: int, ctx: Context) -> int:
            return n * n

        envelope = square.run_envelope(7, _ctx())
        # The client reads exactly what runner.ts writes: {"ok":true,"value":...} / {"ok":false,"error":{...}}.
        self.assertEqual(envelope, Envelope({"ok": True, "value": 49}, None))

        @task(id="broke")
        def broke(n: int, ctx: Context) -> int:
            raise ValueError("no")

        failed = broke.run_envelope(1, _ctx())
        assert isinstance(failed, Envelope)
        error = failed.body["error"]
        assert isinstance(error, dict)
        self.assertEqual((failed.body["ok"], failed.error, error["name"], error["message"]), (False, "ValueError", "ValueError", "no"))

        @task(id="raw-bytes")
        def raw_bytes(n: int, ctx: Context) -> bytes:
            return b"\x00\x01"

        binary = raw_bytes.run_envelope(0, _ctx())
        self.assertEqual(binary, Envelope({"ok": True, "bytes": base64.b64encode(b"\x00\x01").decode()}, None))

    def test_answer_reads_the_envelope_like_task_ts(self) -> None:
        from armada.task import RemoteError, _Value

        @task(id="square")
        def square(n: int, ctx: Context) -> int:
            return n * n

        outcome = {"answer": "value", "value": json.dumps({"ok": True, "value": 9}), "exitCode": 0, "tail": ""}
        self.assertEqual(square.answer(outcome, lambda: None), _Value(9))
        dead = {"answer": "value", "exitCode": 137, "tail": "killed", "output": True}
        error = square.answer(dead, lambda: b"")
        self.assertEqual((type(error).__name__, error.name if isinstance(error, RemoteError) else ""), ("RemoteError", "Exit"))


def _ran(root: Path, task_id: str, item: object) -> tuple[int, str, str, str]:
    """The project's bundle run as a container runs it, from another directory: its exit, its log, its answer marker
    and its out."""
    import os
    import subprocess

    content, _ids = bundle_tasks(root, ["tasks"])
    with tempfile.TemporaryDirectory() as box:
        Path(box, "b.pyz").write_bytes(content)
        env = {**os.environ, "ARMADA_TASK": task_id, "ARMADA_ITEM": json.dumps(item)}
        env.update(ARMADA_OUT=f"{box}/out", ARMADA_ANSWER=f"{box}/answer")
        with open(f"{box}/log", "w") as log:
            ran = subprocess.run([sys.executable, f"{box}/b.pyz"], env=env, stdout=log, stderr=log, cwd="/")

        def read(name: str) -> str:
            return Path(box, name).read_text() if Path(box, name).exists() else ""

        return ran.returncode, read("log"), read("answer"), read("out")


class TestBundle(unittest.TestCase):
    def test_refuses_a_task_folder_named_like_the_sdk_and_leaves_it_importable(self) -> None:
        import armada

        with tempfile.TemporaryDirectory() as scratch:
            Path(scratch, "armada").mkdir()
            Path(scratch, "armada", "jobs.py").write_text("from armada import task\n\n@task(id='t')\ndef t(n, ctx):\n    return n\n")
            with self.assertRaises(PushError):
                bundle_tasks(Path(scratch), ["armada"])
        self.assertIs(sys.modules["armada"], armada)

    def test_runs_as_its_container_does_a_package_with_relative_and_from_list_imports(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            Path(root, "pyproject.toml").write_text('[tool.armada]\nproject="p"\ntasks=["tasks"]\n')
            for folder in ("tasks", "helpers"):
                Path(root, folder).mkdir()
            Path(root, "tasks", "__init__.py").write_text("OFFSET = 1\n")
            Path(root, "helpers", "__init__.py").write_text("")
            Path(root, "helpers", "compute.py").write_text("def double(n):\n    return n * 2\n")
            Path(root, "tasks", "shared.py").write_text("from . import OFFSET\n")
            Path(root, "tasks", "jobs.py").write_text(
                "from armada import sh, task\nfrom helpers import compute\nfrom .shared import OFFSET\n\n"
                "@task(id='twice')\ndef twice(n, ctx):\n    return compute.double(n) + OFFSET\n\n"
                "@task(id='loud')\ndef loud(n, ctx):\n    return sh('echo diagnostic >&2; exit 3')\n\n"
                "def check(n):\n    if n % 2 == 0:\n        raise ValueError('even')\n    return n\n\n"
                "@task(id='odd', output=check)\ndef odd(n, ctx):\n    return n\n\n"
                "@task(id='nan')\ndef nan(n, ctx):\n    return float('nan')\n"
            )
            twice, loud, odd, nan = (_ran(root, name, 20) for name in ("twice", "loud", "odd", "nan"))

            got = {
                "twice": (twice[0], json.loads(twice[3])), "loud": (loud[0], "diagnostic" in loud[1], loud[2]),
                "odd": (odd[0], odd[2]), "nan": (nan[0], nan[2]),
            }
            self.assertEqual(got, {
                "twice": (0, {"ok": True, "value": 41}), "loud": (3, True, "command"),
                "odd": (1, "value\nSchemaError"), "nan": (1, "value\nValueError"),
            })

    def _project(self, root: str) -> None:
        Path(root, "pyproject.toml").write_text('[project]\nname="x"\nversion="0.1.0"\n\n[tool.armada]\nproject="sq"\ntasks=["tasks"]\n')
        Path(root, "tasks").mkdir()
        Path(root, "tasks", "jobs.py").write_text(
            "from armada import task\n\n@task(id='square')\ndef square(n, ctx):\n    return n * n\n"
        )

    def test_finds_the_project_and_bundles_deterministically(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            self._project(scratch)
            self.assertIsNotNone(find_project(str(Path(scratch, "tasks"))))
            one, ids = bundle_tasks(Path(scratch), ["tasks"])
            two, _ = bundle_tasks(Path(scratch), ["tasks"])
            self.assertEqual(one, two)
            self.assertEqual(ids, ["square"])

    def test_bundles_each_project_its_own_helpers_and_the_imports_a_task_makes_only_when_it_runs(self) -> None:
        def project(root: Path, factor: int, lazy: bool) -> None:
            Path(root, "pyproject.toml").write_text('[tool.armada]\nproject="p"\n')
            for folder in ("tasks", "helpers"):
                Path(root, folder).mkdir()
            Path(root, "helpers", "__init__.py").write_text("")
            Path(root, "helpers", "compute.py").write_text(f"def scale(n):\n    return n * {factor}\n")
            body = "    from helpers.compute import scale\n" if lazy else ""
            head = "" if lazy else "from helpers.compute import scale\n"
            Path(root, "tasks", "jobs.py").write_text(
                f"from armada import task\n{head}\n@task(id='scaled')\ndef scaled(n, ctx):\n{body}    return scale(n)\n"
            )
            # A test beside the tasks, which discovery never imports.
            Path(root, "tasks", "jobs.test.py").write_text("raise SystemExit('a test was imported')\n")

        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            project(Path(one), 2, lazy=True)
            project(Path(two), 3, lazy=False)
            first, second = _ran(Path(one), "scaled", 10), _ran(Path(two), "scaled", 10)
            # The first project's sources change; bundled again in this process, the bundle has the change.
            Path(one, "helpers", "compute.py").write_text("def scale(n):\n    return n * 5\n")
            again = _ran(Path(one), "scaled", 10)

        self.assertEqual([json.loads(ran[3]) for ran in (first, second, again)], [{"ok": True, "value": value} for value in (20, 30, 50)])
        self.assertEqual([name for name in sys.modules if name.split(".")[0] in ("tasks", "helpers")], [])

    def test_refuses_two_tasks_sharing_an_id_in_two_files_or_one_and_takes_one_task_under_two_names(self) -> None:
        refused: list[str] = []
        for more in (
            "from armada import task\n\n@task(id='square')\ndef again(n, ctx):\n    return n\n",
            "from armada import task\n\n@task(id='cube')\ndef a(n, ctx):\n    return n\n\n@task(id='cube')\ndef b(n, ctx):\n    return n\n",
        ):
            with tempfile.TemporaryDirectory() as scratch:
                self._project(scratch)
                Path(scratch, "tasks", "more.py").write_text(more)
                with self.assertRaises(PushError) as raised:
                    bundle_tasks(Path(scratch), ["tasks"])
                refused.append(str(raised.exception).split(":")[0])
        with tempfile.TemporaryDirectory() as scratch:
            self._project(scratch)
            Path(scratch, "tasks", "alias.py").write_text("from .jobs import square as squared\n")
            _, ids = bundle_tasks(Path(scratch), ["tasks"])
        self.assertEqual(
            {"refused": refused, "ids": ids}, {"refused": ["two tasks have the id square", "two tasks have the id cube"], "ids": ["square"]}
        )


class TestClient(unittest.TestCase):
    def test_speaks_the_wire_and_retries_a_read(self) -> None:
        counts = {"events": 0}
        seen: dict[str, object] = {}

        class Fake(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def do_GET(self) -> None:
                seen["protocol"] = self.headers.get("armada-protocol")
                seen["auth"] = self.headers.get("authorization")
                if self.path.startswith("/jobs/j/events"):
                    counts["events"] += 1
                    if counts["events"] == 1:
                        self.send_error(502)
                        return
                    self._json({"events": [], "done": True})
                elif self.path == "/jobs/j/tasks/0/output":
                    self._json({"n": 4})
                else:
                    self.send_error(404)

            def do_POST(self) -> None:
                if self.path == "/jobs":
                    self._json({"id": "j"})
                else:
                    self.send_error(404)

            def _json(self, body: object) -> None:
                payload = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = http.server.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            armada = Armada(Connection(f"http://127.0.0.1:{server.server_port}", "tok"))
            self.assertEqual(armada.create({"recipe": {}, "items": [], "run": {"kind": "command"}}), "j")
            # A 502 on a read is asked again; the second answer is the job's events.
            self.assertEqual(armada.events("j", 0), {"events": [], "done": True})
            self.assertEqual(counts["events"], 2)
            self.assertEqual(seen["protocol"], "7")
            self.assertEqual(seen["auth"], "Bearer tok")
            self.assertEqual(armada.output("j", 0), b'{"n": 4}')
            with self.assertRaises(RequestError):
                armada.status("absent-but-not-404")
        finally:
            server.shutdown()


class TestTaskShapes(unittest.TestCase):
    def test_retries_split_codes_from_names(self) -> None:
        from armada.task import _retries

        expected = {"attempts": 3, "exitCodes": [137], "errors": ["TimeoutError"]}
        self.assertEqual(_retries({"attempts": 3, "on": [137, "TimeoutError"]}), expected)

    def test_a_task_validates_its_input_and_output(self) -> None:
        @task(id="typed", input=lambda v: int(v))
        def typed(n: int, ctx: Context) -> int:
            return n

        self.assertEqual(typed.run_envelope("3", _ctx()), Envelope({"ok": True, "value": 3}, None))
        with self.assertRaises(SchemaError):
            typed._wire("not-an-int", 0)

    def test_an_output_model_checks_the_answer_where_it_lands(self) -> None:
        class Point:
            def __init__(self, x: float) -> None:
                self.x = x

            @classmethod
            def model_validate(cls, value: object) -> "Point":
                if not isinstance(value, dict) or not isinstance(value.get("x"), float):
                    raise ValueError("no x")
                return cls(value["x"])

        @task(id="point", output=Point)
        def point(n: int, ctx: Context) -> dict[str, float]:
            return {"x": float(n)}

        # The container sends the body's own JSON, which a model instance would not be.
        sent = point.run_envelope(3, _ctx())
        assert isinstance(sent, Envelope)
        self.assertEqual(json.loads(json.dumps(sent.body)), {"ok": True, "value": {"x": 3.0}})
        landed = point.answer({"answer": "value", "value": json.dumps(sent.body), "exitCode": 0}, lambda: None)
        refused = point.answer({"answer": "value", "value": json.dumps({"ok": True, "value": {"y": 1}}), "exitCode": 0}, lambda: None)
        assert isinstance(landed, _Value)
        assert isinstance(landed.value, Point)
        self.assertEqual((landed.value.x, isinstance(refused, RemoteError)), (3.0, True))


if __name__ == "__main__":
    unittest.main()
