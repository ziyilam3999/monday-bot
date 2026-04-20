# Monday Overview

Monday is a Slack knowledge bot.

## Architecture

Single-process Node.js service on a free-tier ARM Linux box.

## Retrieval

The retrieval core is platform-agnostic. Slack is one adapter among many future surfaces.

## Quality Bar

- Facts-only — no fabrication
- Every claim cited
- ~15 seconds end-to-end on CPU
