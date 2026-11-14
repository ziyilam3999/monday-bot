#!/usr/bin/env bash
# Gate check for README.md: the Status section links the Releases page and carries no inline
# release date (a "vX.Y.Z, YYYY-MM-DD" note goes stale with every release).
# Exit 0 = both hold. Exit 1 = one line per problem on stderr.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec python3 -I - README.md <<'PY'
import re, sys

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read()
except OSError as exc:
    sys.stderr.write("readme-releases: cannot read %s: %s\n" % (sys.argv[1], exc))
    sys.exit(1)

m = re.search(r"^## Status[ \t]*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
if not m:
    sys.stderr.write("readme-releases: no '## Status' section\n")
    sys.exit(1)
status = m.group(1)
bad = 0
if not re.search(r"\]\([^)\s]*/releases/?\)", status):
    sys.stderr.write("readme-releases: Status section has no link to the Releases page\n")
    bad += 1
if re.search(r"v\d+\.\d+\.\d+\s*,?\s*\(?\d{4}-\d{2}-\d{2}", status):
    sys.stderr.write("readme-releases: Status section carries an inline release date\n")
    bad += 1
if bad:
    sys.exit(1)
print("readme-releases: ok")
PY
