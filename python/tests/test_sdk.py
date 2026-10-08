"""The Python SDK's unit tests: quoting, recipe/env-key parity, envelope shapes, bundle determinism, config
discovery, the client against a fake Worker, the MapError/Result shapes and the submission's batches."""

import base64
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from armada import Armada, Connection, MapError, RequestError, SchemaError, ShellError, out_file, raw, recipe, sh, task  # noqa: E402
from armada.push import bundle_tasks, find_project  # noqa: E402
from armada.wire import environment_key  # noqa: E402


class TestSh(unittest.TestCase):
    def test_quotes_each_word_and_leaves_the_template_raw(self) -> None:
        self.assertEqual(sh("echo {}", "a b").script, "echo 'a b'")
        self.assertEqual(sh("echo {}", "plain_1").script, "echo plain_1")
        self.assertEqual(sh("echo {}", "it's").script, "echo 'it'\\''s'")
        self.assertEqual(sh("cp {} {}", ["a", "b"], out_file("/armada/task/out")).script, "cp a b /armada/task/out")
        self.assertEqual(sh("echo $({})", sh("echo hi")).script, "echo $(echo hi)")

    def test_refuses_an_interpolation_inside_quotes(self) -> None:
        with self.assertRaises(ValueError):
            sh('echo "{}"', "word")

    def test_raw_inserts_as_written(self) -> None:
        self.assertEqual(raw("echo {}", "a b").script, "echo a b")

    def test_runs_and_reads(self) -> None:
        self.assertEqual(sh("echo hi").text(), "hi\n")
        with self.assertRaises(ShellError) as raised:
            sh("echo bad >&2; exit 3").run()
        self.assertEqual(raised.exception.exit_code, 3)
        self.assertIn("bad", str(raised.exception))


class TestRecipe(unittest.TestCase):
    def test_hashes_to_the_same_environment_key_as_the_ts_builder(self) -> None:
        # Both digests are src/protocol.ts's environmentKey of the same recipes (bun -e, 2026-10-08).
        self.assertEqual(
            environment_key(recipe.debian().apt("ffmpeg").size("small").install("pip install httpx").spec),
            "d8c5273ffe726a65c5916d14eab38bc97ae3b98adcc9d6a2334dc045b0dceb78",
        )
        self.assertEqual(environment_key(recipe.debian().spec), "f2f8d07dddb2aae1ca71538e2ff229cb1b97523099e80ca5a3785d390c6cd2cd")

    def test_appends_steps_in_order(self) -> None:
        built = recipe().apt("curl").setup("echo more").install("a").install("b").spec
        self.assertEqual(built["setup"].split("\n")[-1], "echo more")
        self.assertEqual(built["install"], "a\nb")


class TestEnvelope(unittest.TestCase):
    def test_value_and_error_round_trip_through_the_wire_shapes(self) -> None:
        from armada.runner import run_tasks  # noqa: F401 — the in-container side

        @task(id="square")
        def square(n: int, ctx: object) -> int:
            return n * n

        envelope = square.run_envelope(7, None)  # type: ignore[arg-type]
        # The client reads exactly what runner.ts writes: {"ok":true,"value":...} / {"ok":false,"error":{...}}.
        self.assertEqual(envelope, {"ok": True, "value": 49})

        @task(id="broke")
        def broke(n: int, ctx: object) -> int:
            raise ValueError("no")

        failed = broke.run_envelope(1, None)  # type: ignore[arg-type]
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["error"]["name"], "ValueError")
        self.assertEqual(failed["error"]["message"], "no")

        @task(id="raw-bytes")
        def raw_bytes(n: int, ctx: object) -> bytes:
            return b"\x00\x01"

        binary = raw_bytes.run_envelope(0, None)  # type: ignore[arg-type]
        self.assertEqual(binary, {"ok": True, "bytes": base64.b64encode(b"\x00\x01").decode()})

    def test_answer_reads_the_envelope_like_task_ts(self) -> None:
        @task(id="square")
        def square(n: int, ctx: object) -> int:
            return n * n

        outcome = {"answer": "value", "value": json.dumps({"ok": True, "value": 9}), "exitCode": 0, "tail": ""}
        self.assertEqual(square.answer(outcome, lambda: None), ("ok", 9))
        dead = {"answer": "value", "exitCode": 137, "tail": "killed", "output": True}
        kind, error = square.answer(dead, lambda: b"")
        self.assertEqual((kind, error.name), ("error", "Exit"))


class TestBundle(unittest.TestCase):
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

    def test_refuses_two_tasks_sharing_an_id(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            self._project(scratch)
            Path(scratch, "tasks", "more.py").write_text(
                "from armada import task\n\n@task(id='square')\ndef again(n, ctx):\n    return n\n"
            )
            with self.assertRaises(Exception) as raised:
                bundle_tasks(Path(scratch), ["tasks"])
            self.assertIn("two tasks have the id square", str(raised.exception))


class TestClient(unittest.TestCase):
    def test_speaks_the_wire_and_retries_a_read(self) -> None:
        counts = {"events": 0}
        seen: dict[str, object] = {}

        class Fake(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
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

            def do_POST(self) -> None:  # noqa: N802
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
    def test_result_and_maperror_shapes(self) -> None:
        from armada.task import Meta, Result

        results = [
            Result(0, "a", Meta(1.0, 1, "v1", 0, ""), True, "ok", value="x"),
            Result(1, "b", Meta(1.0, 1, "v1", 124, "tail"), False, "timeout"),
        ]
        raised = MapError(results)
        self.assertIn("1 of 2", str(raised))
        self.assertIn("timed out", str(raised))

    def test_retries_split_codes_from_names(self) -> None:
        from armada.task import _retries

        self.assertEqual(_retries({"attempts": 3, "on": [137, "TimeoutError"]}), {"attempts": 3, "exitCodes": [137], "errors": ["TimeoutError"]})

    def test_a_task_validates_its_input_and_output(self) -> None:
        @task(id="typed", input=lambda v: int(v))
        def typed(n: int, ctx: object) -> int:
            return n

        self.assertEqual(typed.run_envelope("3", None), {"ok": True, "value": 3})  # type: ignore[arg-type]
        with self.assertRaises(SchemaError):
            typed._wire("not-an-int", 0)


if __name__ == "__main__":
    unittest.main()
