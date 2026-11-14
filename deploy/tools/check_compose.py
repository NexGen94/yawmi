"""Check the compose files that go through the Hostinger Docker Manager.

    python -I deploy/tools/check_compose.py deploy/compose

Standard library only. Exit code 0 when every file passes, 1 otherwise (also when there is
nothing to check, so an empty or misspelt path never looks like a pass). A file fails when it:

* is longer than 8192 characters (the Docker Manager refuses more);
* contains a carriage return (the files go to a Linux server, LF only);
* contains something shaped like an IPv4 address or an API key prefix (`sk-`);
* has an `image:` without a tag, with an interpolated tag, or tagged `latest`.

The messages never echo the offending text, only where it is and what rule it broke.
"""

import re
import sys
from collections.abc import Sequence
from pathlib import Path

MAX_CHARS = 8192

_IPV4 = re.compile(r"\b\d{1,3}(\.\d{1,3}){3}\b")
_ANY_ADDRESS = ".".join(("0",) * 4)  # a listen address (uvicorn --host), not a server's
_API_KEY_PREFIX = re.compile(r"\bsk-")
_IMAGE_LINE = re.compile(r"^\s*image:\s*(?P<ref>[^\s#]+)")


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _image_problem(ref: str) -> str | None:
    """Why `ref` is not an acceptable image reference, or `None` when it is pinned."""
    ref = ref.strip("'\"")
    if "@sha256:" in ref:
        return None  # a digest pins the image harder than any tag
    name = ref.rsplit("/", 1)[-1]  # the registry host may carry a port (`host:5000/x`)
    if ":" not in name:
        return f"الصورة بلا وسم: {ref}"
    tag = name.split(":", 1)[1]
    if "$" in tag:
        return f"وسم الصورة يجب أن يكون حرفياً لا متغيراً: {ref}"
    if tag.lower() == "latest":
        return f"الوسم latest ممنوع: {ref}"
    return None


def check_text(text: str) -> list[str]:
    """Every rule broken by `text`, as `line N: message` strings (empty when it is clean)."""
    problems: list[str] = []
    if len(text) > MAX_CHARS:
        problems.append(f"الطول {len(text)} حرفاً وفوق الحد {MAX_CHARS}")
    if "\r" in text:
        problems.append(f"سطر {_line_of(text, text.index(chr(13)))}: فيه \\r، والمطلوب LF فقط")
    for match in _IPV4.finditer(text):
        if match.group(0) == _ANY_ADDRESS:
            continue  # the bind-to-every-interface address names no server
        problems.append(f"سطر {_line_of(text, match.start())}: نمط عنوان IP")
    for match in _API_KEY_PREFIX.finditer(text):
        problems.append(f"سطر {_line_of(text, match.start())}: بادئة مفتاح sk-")
    for number, line in enumerate(text.split("\n"), start=1):
        if line.lstrip().startswith("#"):
            continue
        image = _IMAGE_LINE.match(line)
        if image and (problem := _image_problem(image["ref"])):
            problems.append(f"سطر {number}: {problem}")
    return problems


def _collect(paths: Sequence[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files += sorted([*path.glob("*.yml"), *path.glob("*.yaml")])
        elif path.is_file():
            files.append(path)
    return files


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    paths = list(sys.argv[1:] if argv is None else argv)
    files = _collect(paths)
    if not files:
        print("لا ملفات compose للفحص", file=sys.stdout)
        return 1
    failed = False
    for file in files:
        try:
            text = file.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            problems = ["الملف ليس UTF-8"]
        else:
            problems = check_text(text)
        if problems:
            failed = True
            for problem in problems:
                print(f"{file.name}: {problem}")
        else:
            print(f"{file.name}: سليم ({len(text)} حرفاً)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
