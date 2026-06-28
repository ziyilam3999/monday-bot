# Jira dashboard guide — viewing the bot's namespaced labels

Stage C of the namespaced-labels work gives you two ways to *look at* the bot's
`mb-symptom-*` / `mb-feature-*` / `mb-flow-*` stickers:

1. The **`/jql` skill** (terminal + Slack) — type an English question, get a JQL
   string (and optionally the matching defects). See the repo README / `npm run jql`.
2. **This guide** — a one-time, click-by-click setup of an always-on Jira
   dashboard built entirely from Jira's OWN built-in chart gadgets. There is no
   Jira-admin API for creating dashboards, so this is a human-followed recipe, not
   code.

All examples below use SYNTHETIC names only: the site `example.atlassian.net`, the
project `DEMO`, and invented labels `mb-feature-widget` / `mb-flow-onboarding`.
Substitute your own site, project, and (real, gitignored) catalog values as you go.

> **Now vs Later in one sentence:** the **symptom** axis is LIVE today (73 open
> defects already carry `mb-symptom-*`), so symptom gadgets are useful immediately;
> the **feature/flow** axis is wired but *inert* until the deferred classifier
> (#1064) populates those labels — feature/flow gadgets render empty until then.

---

## Prerequisite — save a filter of the bot's labels

Jira label matching is EXACT (there is no `mb-*` wildcard), so you first need an
enumerated filter of every bot label.

1. Get the enumerated clause:

   ```
   npm run triage:backfill -- --print-jql
   ```

   It prints a `labels in ("mb-symptom-crash-error", …)` clause (structure only —
   safe to paste).

2. In Jira (`https://example.atlassian.net`), open **Filters → Advanced issue
   search**, switch to **JQL** mode, paste the clause, prepend `project = DEMO AND `,
   and **Save as** → name it `Bot-labeled defects`.

You now have a saved filter every gadget below can point at.

---

## Gadget A — Pie / Bar of `mb-symptom-*` — useful NOW

Shows the symptom mix across the open defects (e.g. how many `mb-symptom-crash-error`
vs `mb-symptom-performance`).

1. **Dashboards → Create dashboard** → name it `Defect triage`.
2. **Add gadget → Pie Chart** (or **Bar Chart**).
3. **Filter:** `Bot-labeled defects`. **Statistic Type:** `Labels`.
4. Save. Because the symptom axis is live, this gadget is populated **today**.

> Tip: to focus purely on symptoms, save a second filter
> `project = DEMO AND labels in ("mb-symptom-crash-error", …)` (symptom labels only)
> and point the Pie/Bar gadget at that.

## Gadget B — Two-Dimensional Filter Statistics (feature × symptom) — useful LATER

A grid with one axis = feature label, the other = symptom label — the "which areas
crash most" view.

1. **Add gadget → Two-Dimensional Filter Statistics** (the **2-D** / two-dimensional
   gadget).
2. **Filter:** `Bot-labeled defects`.
3. **X Axis:** `Labels`. **Y Axis:** `Labels`.
4. Save. The **feature rows are EMPTY until the deferred feature/flow matcher
   (#1064) runs** — once it stamps `mb-feature-*` / `mb-flow-*` onto issues, this
   grid fills in automatically with NO further setup. Useful **LATER**.

## Gadget C — one saved filter per symptom (8 filters) — useful NOW

For per-symptom counts / swimlanes.

1. For each of the 8 symptom categories, save a filter like
   `project = DEMO AND labels = "mb-symptom-crash-error"`.
2. Add a **Filter Results** (or **Issue Statistics**) gadget per filter, or use them
   as board swimlane queries. Live **today**.

---

## Now vs Later — gadget readiness table

| Gadget | Built on | Axis it needs | Useful NOW or LATER |
|---|---|---|---|
| A — Pie / Bar of symptoms | `Labels` statistic | symptom (live) | **NOW** |
| B — Two-Dimensional Filter Statistics (feature × symptom) | 2-D `Labels` × `Labels` | feature/flow (deferred #1064) | **LATER** — feature rows empty until the matcher runs |
| C — per-symptom saved filters (×8) | `labels = "mb-symptom-…"` | symptom (live) | **NOW** |

The dashboard is built once and self-updates: the symptom gadgets work from day one,
and the feature/flow gadget (B) lights up on its own the moment the deferred matcher
populates `mb-feature-*` / `mb-flow-*` — no dashboard change needed.
