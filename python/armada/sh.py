"""Shell commands from a template, every ``{}`` filled as one quoted word, as sh.ts's tagged template does.
A task whose body returns a ``Shell`` is a command: its runner runs it, and the task answers with what it
wrote to ``out``. ``{{`` and ``}}`` write a literal brace."""

import os
import re
import subprocess
from dataclasses import dataclass
from typing import IO, Optional, Union

_SAFE = re.compile(r"^[A-Za-z0-9_@%+=:,./-]+$")


def quote(word: str) -> str:
    """One word for the shell, single-quoted unless it needs no quoting."""
    return word if _SAFE.match(word) else "'" + word.replace("'", "'\\''") + "'"


class ShellError(Exception):
    """A command that exited nonzero: its script, code and stderr's last lines."""

    def __init__(self, script: str, exit_code: int, stderr: str) -> None:
        tail = stderr.strip()
        super().__init__(f"`{script}` exited {exit_code}" + ("" if tail == "" else ": " + "\n".join(tail.split("\n")[-5:])))
        self.script = script
        self.exit_code = exit_code
        self.stderr = stderr


@dataclass(frozen=True)
class OutFile:
    """The file a task answers with: interpolated into `sh` as its path."""

    path: str


def out_file(path: str) -> OutFile:
    return OutFile(path)


Word = Union[str, int, float, OutFile, "Shell", "list[Word]"]


@dataclass(frozen=True)
class Shell:
    """A command that has not run."""

    script: str

    def run(self, env: Optional[dict[str, str]] = None) -> "Completed":
        ran = execute(self.script, env=env)
        if ran.exit_code != 0:
            raise ShellError(self.script, ran.exit_code, ran.stderr)
        return ran

    def text(self, env: Optional[dict[str, str]] = None) -> str:
        return self.run(env).stdout


@dataclass(frozen=True)
class Completed:
    exit_code: int
    stdout: str
    stderr: str


def execute(script: str, env: Optional[dict[str, str]] = None, stdout: Optional[IO[bytes]] = None) -> Completed:
    """Runs `script` under /bin/sh, with stdout and stderr read whole unless `stdout` streams it."""
    child = subprocess.Popen(["/bin/sh", "-c", script], env={**os.environ, **(env or {})}, stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = child.communicate()

    return Completed(child.returncode if child.returncode >= 0 else 128, (out or b"").decode(errors="replace"), err.decode(errors="replace"))


def _is_shell(value: object) -> bool:
    return isinstance(value, Shell)


def _interpolated(value: object) -> str:
    if isinstance(value, Shell):
        return value.script
    if isinstance(value, OutFile):
        return quote(value.path)
    if isinstance(value, list):
        return " ".join(quote(str(each)) for each in value)
    if isinstance(value, (str, int, float)):
        return quote(str(value))
    raise TypeError(f"a {{}} takes a word, a list of words, an out file or a shell, not {type(value).__name__}")


def _quoted_prefix(script: str) -> bool:
    """Whether the shell is inside quotes at the end of `script`: an interpolation quoted again there would be
    read inside them, where ``$(...)`` still runs within double quotes."""
    mark = ""
    at = 0
    while at < len(script):
        char = script[at]
        if mark != "'" and char == "\\":
            at += 1
        elif mark == "" and char in "'\"":
            mark = char
        elif char == mark:
            mark = ""
        at += 1
    return mark != ""


def _template(template: str, words: tuple[object, ...], escape: bool) -> Shell:
    parts = template.replace("{{", "\x00").replace("}}", "\x01").split("{}")
    if len(parts) - 1 != len(words):
        raise ValueError(f"the template has {len(parts) - 1} placeholders for {len(words)} words")
    script = ""
    for at, part in enumerate(parts):
        script += part.replace("\x00", "{").replace("\x01", "}")
        if at < len(words):
            if escape and _quoted_prefix(script):
                raise ValueError("sh quotes each {} itself: write sh('echo {}', word), not sh('echo \"{}\"', word)")
            script += _interpolated(words[at]) if escape else str(words[at])
    return Shell(script)


def sh(template: str, *words: object) -> Shell:
    """A command, each `{}` filled with one word quoted for the shell; the template's own text is raw."""
    return _template(template, words, True)


def raw(template: str, *words: object) -> Shell:
    """Interpolates as written, unescaped: for a script that is itself shell."""
    return _template(template, words, False)
