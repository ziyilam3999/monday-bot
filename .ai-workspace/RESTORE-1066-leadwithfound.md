# RESTORE note — 1066-leadwithfound worktree

- Restore command (post-merge): `mv ~/coding_projects/monday-bot/.claude/worktrees/1066-leadwithfound`
  to `~/coding_projects/_quarantine/1066-leadwithfound-YYYYMMDD/` (Rule 14, mv-not-rm) AND
  `git -C ~/coding_projects/monday-bot worktree prune`.
- Trigger: after the PR merges and the release tag is cut.
- Why: temporary isolated worktree for the #1066 lead-with-found iteration-2 prompt fix (Rule 12).
- Do NOT touch the operator's primary clone or the running launchd service.
