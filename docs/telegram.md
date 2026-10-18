# Telegram adapter — operator runbook (#3277, 2-week test)

monday-bot answers questions from Telegram beside Slack. The adapter is
**outbound-only**: the bot calls Telegram (`getUpdates` long polling), exactly
the same hosting shape as Slack Socket Mode — no public server, no webhook, no
new account machinery. This file is everything the operator needs to run,
measure, and kill the experiment.

## 1. Create the bot (one-time, ~5 minutes)

1. In Telegram, message **@BotFather** → `/newbot`. Follow the prompts (name,
   then a username ending in `bot`). This mirrors the Slack app ritual
   (api.slack.com/apps → your app) from the original onboarding.
2. BotFather replies with the bot **token** — that value is
   `TELEGRAM_BOT_TOKEN`.
3. Press **Start** (or send any message) in your new bot's chat so a chat
   exists.

## 2. Find your own chat id

Message **@userinfobot** (or any "what is my id" bot) from the account you
will ask questions from; it replies with your numeric id. In a private 1:1
chat with a bot, your chat id IS your user id (a positive number).

## 3. Allow-list rules (fail closed)

Set in `.env`:

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

- **Only chat ids on the list get any answer.** Anyone else gets silence: no
  query runs, no reply is sent, nothing is logged.
- **Fail closed:** with `TELEGRAM_BOT_TOKEN` set, an empty, missing or invalid
  `TELEGRAM_ALLOWED_CHAT_IDS` means the bot **refuses to start** (startup exit,
  same as a missing Slack token). Leaving both vars unset runs Slack-only
  exactly as before — no Telegram code is even constructed.
- **An entry is a whole chat.** Allowing a GROUP chat id (negative number)
  lets **every member of that group** query the knowledge base. v1 guidance:
  allow only private, per-person chat ids (positive numbers).
- Multiple ids: comma-separated (`123456789,987654321`).

## 4. Behaviour notes

- **Drain rule:** messages sent while the bot was down are **never answered**.
  At boot the adapter acknowledges and discards the queued backlog (including
  the most recent queued message); only messages arriving after boot are
  answered. This is deliberate — no stale-question replays after a restart.
- Replies are plain text, split at Telegram's 4096-char ceiling when needed.
- A Telegram outage never takes the bot down: mid-run poll failures back off
  (5s doubling to 60s) for up to 10 consecutive tries, then the channel parks
  itself (one log line) while Slack keeps running. Restart to re-enable.
  A bad token or a competing poller at boot, however, is treated as
  misconfiguration: startup fails loudly.

## 5. The ask log (2-week measure)

Every ALLOWED ask appends one JSON line to
`~/Library/Logs/monday-bot-telegram-asks.jsonl` (override with
`MONDAY_TELEGRAM_ASK_LOG`):

```json
{"ts":"2026-10-18T09:00:00.000Z","chatHash":"ab12cd34ef56","questionLen":37,"cited":true,"latencyMs":1840}
```

The question **text** and the raw chat id are never stored — `chatHash` is the
first 12 hex chars of `sha256(<chat id>)`, enough to count distinct askers.

jq one-liners for the four measures:

```sh
LOG=~/Library/Logs/monday-bot-telegram-asks.jsonl

# distinct askers
jq -s 'map(.chatHash) | unique | length' "$LOG"

# questions per ISO week (the log file itself spans only the 2-week run —
# no hardcoded start date; %G-W%V is the ISO-8601 week, so a week straddling
# a month boundary is ONE bucket, never two)
jq -s 'map(.ts[0:10] | strptime("%Y-%m-%d") | mktime | strftime("%G-W%V")) | group_by(.) | map({week: .[0], asks: length})' "$LOG"

# citation rate
jq -s 'map(.cited) | (map(select(. == true)) | length) / length' "$LOG"

# median latency (ms)
jq -s 'map(.latencyMs) | sort | .[length / 2 | floor]' "$LOG"
```

Worked example — invented 3-line sample (two asks in ISO week 2026-W41, one
in 2026-W42):

```json
{"ts":"2026-10-05T09:00:00.000Z","chatHash":"8a9bcf1e51e8","questionLen":37,"cited":true,"latencyMs":1840}
{"ts":"2026-10-07T11:30:00.000Z","chatHash":"8a9bcf1e51e8","questionLen":21,"cited":false,"latencyMs":900}
{"ts":"2026-10-13T15:00:00.000Z","chatHash":"ab12cd34ef56","questionLen":19,"cited":true,"latencyMs":1200}
```

The per-week line prints:

```json
[
  {"week": "2026-W41", "asks": 2},
  {"week": "2026-W42", "asks": 1}
]
```

(Cross-checked against Python's `datetime.isocalendar()`. The pre-fix version
of this one-liner grouped by `YYYY-MM`, which folded the whole sample into
one "2026-10" bucket and could not answer questions-per-week.)

Your own chat's hash, so "nobody but the operator" is decidable:

```sh
echo -n "<your chat id>" | shasum -a 256   # first 12 hex chars
```

Operator observation to note in the 2-week write-up (not loggable
automatically): would any asker have used WhatsApp instead?

## 6. Kill rule

If after 2 weeks nobody but the operator has used the Telegram channel
(distinct askers = 1 in the log), park the experiment: unset
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_IDS` (the adapter goes inert)
or revert the feature commit.
