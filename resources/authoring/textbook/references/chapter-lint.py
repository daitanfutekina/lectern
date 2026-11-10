r"""Lint a Lectern chapter.

Usage: chapter-lint.py NEW.md [OLD.md]

Checks directive names and nesting, display-math delimiters, SVG presentation
attributes, and (when OLD.md is supplied) preserved headings and exercise titles.
"""

from pathlib import Path
import re
import sys


def fail(message):
    global failures
    failures += 1
    print("FAIL", message.encode("ascii", "replace").decode())


def directive_names():
    skill = Path(__file__).parent.parent / "SKILL.md"
    text = skill.read_text(encoding="utf8")
    names = set(re.findall(r"^\| `([a-z-]+)` \|", text, flags=re.M))
    if not names:
        raise RuntimeError("No directive table found in SKILL.md")
    return names


def headings(text):
    return re.findall(r"^##\s+(.+?)\s*$", text, flags=re.M)


def exercise_titles(text):
    return re.findall(r"^:{3,}(?:example|problem)\[([^\]]+)\]", text, flags=re.M)


if len(sys.argv) not in (2, 3):
    print("usage: chapter-lint.py NEW.md [OLD.md]", file=sys.stderr)
    raise SystemExit(2)

new_path = Path(sys.argv[1])
old_path = Path(sys.argv[2]) if len(sys.argv) == 3 else None
new = new_path.read_text(encoding="utf8")
old = old_path.read_text(encoding="utf8") if old_path else None
allowed = directive_names()
failures = 0

# Code samples can contain directive-like punctuation that is not chapter syntax.
body = re.sub(r"```.*?```", "", new, flags=re.S)
stack = []
for line_number, line in enumerate(body.splitlines(), 1):
    match = re.match(r"^(:{3,})\s*([A-Za-z-]*)", line)
    if not match:
        continue
    width, name = len(match.group(1)), match.group(2)
    if name:
        if name not in allowed:
            fail(f"line {line_number}: unknown directive {name}")
        if stack and width >= stack[-1][0]:
            fail(
                f"line {line_number}: nested {name} uses {width} colons "
                f"inside a {stack[-1][0]}-colon container"
            )
        stack.append((width, line_number, name))
    elif not stack or stack[-1][0] != width:
        expected = stack[-1][0] if stack else "no open container"
        fail(f"line {line_number}: {width}-colon close; expected {expected}")
        if stack:
            stack.pop()
    else:
        stack.pop()

for width, line_number, name in stack:
    fail(f"line {line_number}: unclosed {name} directive ({width} colons)")

for line_number, line in enumerate(new.splitlines(), 1):
    stripped = line.strip()
    if stripped.startswith("$$") and len(stripped) > 2:
        if not (stripped.endswith("$$") and len(stripped) > 4):
            fail(f"line {line_number}: opening $$ must be on its own line")
    elif stripped.endswith("$$") and stripped != "$$":
        fail(f"line {line_number}: closing $$ must be on its own line")

for svg in re.findall(r"<svg.*?</svg>", new, flags=re.S | re.I):
    attribute = re.search(r"\s(fill|stroke|style|font-size)\s*=", svg, flags=re.I)
    if attribute:
        fail(f"SVG uses presentation attribute {attribute.group(1)}")

if old is not None:
    for heading in headings(old):
        if heading not in headings(new):
            fail(f"missing old heading: {heading}")
    for title in exercise_titles(old):
        if title not in exercise_titles(new):
            fail(f"missing old example/problem title: {title}")

for section in re.split(r"^##\s+", new, flags=re.M)[1:]:
    title, _, content = section.partition("\n")
    without_svg = re.sub(r"<svg.*?</svg>", "", content, flags=re.S | re.I)
    print(f"{len(without_svg.split()):6d}  {title[:60]}".encode("ascii", "replace").decode())

print("LINT", "FAIL" if failures else "OK", failures)
raise SystemExit(1 if failures else 0)
