#!/usr/bin/env bash
# Gate check for non-code paths (docs, changelog, README, CI workflows, deploy files, dotfiles, gates folder).
# This is a TEXT-HYGIENE check only; it does not prove the content is correct or that YAML/plist parses:
#   every tracked file in those paths is valid UTF-8, has no NUL byte, and has no git merge-conflict marker line (<<<<<<< or >>>>>>>);
#   every tracked gates/*.json parses as JSON.
# Exit 0 = all hold. Exit 1 = one line per problem on stderr.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git ls-files -z -- docs CHANGELOG.md README.md .github deploy .gitignore .env.example .ai-workspace gates |
  exec python3 -I -c '
import json, re, sys
names = [n for n in sys.stdin.buffer.read().split(b"\0") if n]
bad = 0
marker = re.compile(r"^(<{7}|>{7})( |$)", re.M)
for raw in names:
    name = raw.decode("utf-8", "replace")
    try:
        data = open(name, "rb").read()
    except OSError as exc:
        sys.stderr.write("docs-check: cannot read %s: %s\n" % (name, exc)); bad += 1; continue
    if b"\0" in data:
        sys.stderr.write("docs-check: %s: NUL byte (binary?)\n" % name); bad += 1; continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        sys.stderr.write("docs-check: %s: not valid UTF-8\n" % name); bad += 1; continue
    if marker.search(text):
        sys.stderr.write("docs-check: %s: merge-conflict marker line\n" % name); bad += 1
    if name.startswith("gates/") and name.endswith(".json"):
        try:
            json.loads(text)
        except ValueError as exc:
            sys.stderr.write("docs-check: %s: invalid JSON: %s\n" % (name, exc)); bad += 1
if bad:
    sys.exit(1)
print("docs-check: ok (%d files)" % len(names))
'
