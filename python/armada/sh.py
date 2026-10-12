"""Shell commands from a template, every ``{}`` filled as one quoted word, as sh.ts's tagged template does.
A task whose body returns a ``Shell`` is a command: its runner runs it, and the task answers with what it
wrote to ``out``. ``{{`` and ``}}`` write a literal brace."""

import os
import re
import subprocess
from dataclasses import dataclass
from typing import IO, Union

_SAFE = re.compile(r"[A-Za-z0-9_@%+=:,./-]+")


def quote(word: str) -> str:
    """One word for the shell, single-quoted unless it needs no quoting."""
    return word if _SAFE.fullmatch(word) else "'" + word.replace("'", "'\\''") + "'"


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

    def run(self, env: dict[str, str] | None = None) -> "Completed":
        ran = execute(self.script, env=env)
        if ran.exit_code != 0:
            raise ShellError(self.script, ran.exit_code, ran.stderr)
        return ran

    def text(self, env: dict[str, str] | None = None) -> str:
        return self.run(env).stdout


@dataclass(frozen=True)
class Completed:
    exit_code: int
    stdout: str
    stderr: str


def execute(script: str, env: dict[str, str] | None = None, stdout: IO[bytes] | None = None, inherit: bool = False) -> Completed:
    """Runs `script` under /bin/sh, with stdout and stderr read whole unless `stdout` streams it, or `inherit` leaves
    both this process's: a task's command writes to the task's log."""
    piped = None if inherit else subprocess.PIPE
    child = subprocess.Popen(["/bin/sh", "-c", script], env={**os.environ, **(env or {})}, stdout=stdout or piped, stderr=piped)
    out, err = child.communicate()

    code = child.returncode if child.returncode >= 0 else 128
    return Completed(code, (out or b"").decode(errors="replace"), (err or b"").decode(errors="replace"))


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


_HEREDOC = re.compile(r"""<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)""")
_UNQUOTED = re.compile(r"""'([^']*)'|"([^"]*)"|\\(.)""")


def _context(script: str) -> str | None:
    """Where the end of `script` leaves the shell when it is not reading plain words, as sh.ts's `context` says:
    inside quotes, where ``$(...)`` still runs within double quotes, or inside a here-document's body, where the shell
    expands ``$(...)`` through any quotes. An interpolation in either is not one literal word."""
    mark = ""
    arithmetic = 0
    pending: list[tuple[str, bool]] = []
    body: tuple[str, bool] | None = None
    at = 0
    while at < len(script):
        if body is not None:
            end = script.find("\n", at)
            if end == -1:
                return "heredoc"
            line = script[at:end]
            if (line.lstrip("\t") if body[1] else line) == body[0]:
                body = pending.pop(0) if pending else None
            at = end + 1
            continue
        char = script[at]
        if mark != "'" and char == "\\":
            at += 1
        elif mark == "" and char in "'\"":
            mark = char
        elif char == mark:
            mark = ""
        elif mark == "" and script.startswith("$((", at):
            arithmetic += 1
            at += 2
        elif arithmetic > 0 and script.startswith("))", at):
            arithmetic -= 1
            at += 1
        elif mark == "" and char == "\n" and pending:
            body = pending.pop(0)
        elif mark == "" and arithmetic == 0 and char == "#" and (at == 0 or script[at - 1].isspace() or script[at - 1] in ";&|()<>"):
            # A comment, to its line's end: a `<<` in it opens nothing.
            end = script.find("\n", at)
            at = len(script) if end == -1 else end - 1
        elif mark == "" and arithmetic == 0 and script.startswith("<<", at) and not script.startswith("<<<", at):
            heredoc = _HEREDOC.match(script, at)
            if heredoc is not None:
                # The delimiter is the word with its quoting removed: 'E'OF and \EOF both end at a line EOF.
                word = _UNQUOTED.sub(lambda found: found.group(1) or found.group(2) or found.group(3) or "", heredoc.group(2))
                pending.append((word, heredoc.group(1) == "-"))
                at = heredoc.end() - 1
        at += 1
    if body is not None:
        return "heredoc"
    return None if mark == "" else "quotes"


_MISPLACED = {
    "quotes": "sh quotes each {} itself: write sh('echo {}', word), not sh('echo \"{}\"', word)",
    "heredoc": "sh cannot make a {} one word inside a here-document: pass it as an argument, as sh(\"printf '%s\\n' {}\", word)",
}


def _template(template: str, words: tuple[object, ...], *, escape: bool) -> Shell:
    parts = template.replace("{{", "\x00").replace("}}", "\x01").split("{}")
    if len(parts) - 1 != len(words):
        raise ValueError(f"the template has {len(parts) - 1} placeholders for {len(words)} words")
    script = ""
    for at, part in enumerate(parts):
        script += part.replace("\x00", "{").replace("\x01", "}")
        if at < len(words):
            where = _context(script) if escape else None
            if where is not None:
                raise ValueError(_MISPLACED[where])
            script += _interpolated(words[at]) if escape else str(words[at])
    return Shell(script)


def sh(template: str, *words: object) -> Shell:
    """A command, each `{}` filled with one word quoted for the shell; the template's own text is raw."""
    return _template(template, words, escape=True)


def raw(template: str, *words: object) -> Shell:
    """Interpolates as written, unescaped: for a script that is itself shell."""
    return _template(template, words, escape=False)
