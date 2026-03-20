# openclaw-listen-only

**Your agent listens. Learns. Speaks only when spoken to.**

Listen-Only mode lets your OpenClaw agent observe group chats without making LLM calls – and respond with full context when triggered.

500 messages, 0 triggers = **$0.00 in LLM costs** (vs. ~$4.80 with `activation=always`).

## Quick Start

```yaml
groupChat:
  listenOnly:
    enabled: true
```

That's it. Your agent now silently observes group messages, batches them into context windows, and only makes an LLM call when explicitly triggered (e.g. @mention).

## What it does

OpenClaw's default `activation=always` mode runs a full LLM call on every group message – even "ok", "lol", and "brb". The `NO_REPLY` filter catches irrelevant messages, but only *after* the LLM has already been invoked. Every silent message costs tokens.

Listen-Only flips this: a **Pre-LLM gate** checks for triggers *before* calling the LLM. Non-trigger messages are stored as context without any LLM cost.

```
inbound message → bot-filter → trigger check
                                  ├─ trigger    → normal reply (LLM call)
                                  └─ no trigger → listen-only (no LLM call)
                                                    ├─ message → session transcript
                                                    ├─ message → silent batch
                                                    └─ message → L0 raw log
```

## Core concepts

### Silent Batching

Non-trigger messages are bundled into time-windowed blocks (default: 5 min / 50 messages) instead of individual turns. When your agent is triggered, it sees the full batch history as context.

```
─── Seminar group chat ── Members: Lu, Friedrich, Paul, @TABot ───

[Mar 3, 14:05 · Lu]        Thursday is the Laozi block – everyone read chapters 1-20.
[Mar 3, 14:05 · Paul]      Which translation are we using?
[Mar 3, 14:06 · Friedrich]  Check the pinned message in #materialien. See you next week!
```

No LLM call. @TABot silently stores all three messages.

One week later, same group chat:

```
[Mar 10, 09:30 · Lu]        Friedrich, how was your weekend?
[Mar 10, 09:31 · Friedrich]  Great!
[Mar 10, 09:32 · Lu]        @TABot What's today's session about?
[Mar 10, 09:32 · @TABot]    Today is the Laozi block. The group agreed to read
                             chapters 1–20 of the Daodejing. Friedrich posted
                             the translation link in #materialien last Tuesday.
[Mar 10, 09:33 · Lu]        Oops.
```

### L0/L1 Memory Pipeline

- **L0 (raw log):** Every message is appended to `memory/group-log/YYYY-MM-DD.md`. No LLM call, no cost. 90-day retention.
- **L1 (summary):** Periodic LLM runs (via Haiku) extract decisions, to-dos, and facts from L0 into `memory/group-summary/`. Budget-capped, watermark-based, deduplicated.

Unlike `neverReply` (PR #42400), which stores messages as pending history until `historyLimit` is reached and then discards them, Listen-Only preserves context indefinitely via L0 and distills it via L1.

### Proactive engagement (opt-in)

When enabled, the L1 run can trigger a quote-reply if it detects a factual error, a forgotten action item, or relevant context from memory. No extra LLM cost – it's a side-effect of the L1 budget.

```yaml
triggers:
  proactive:
    enabled: false  # default: off
    categories: [fact_correction, forgotten_action, relevant_context]
    cooldownSeconds: 3600
```

### Bot-to-bot safety

Bot messages from other agents are kept in batch context (for cross-agent knowledge transfer) but **never trigger** a reply. No feedback loops.

```yaml
ignoreSelf: true
ignoreKnownBotIds: []
onlyHumanTriggers: true
```

## How it relates to neverReply

[neverReply (PR #42400)](https://github.com/openclaw/openclaw/pull/42400) solves the silence problem across 14 channels with platform-specific history recording. Listen-Only solves the *context decay* problem that silence creates.

**Architectural difference:** neverReply implements silence in each of the 14 channel handlers individually (51 files changed). Listen-Only takes a different route: [PR #45318](https://github.com/openclaw/openclaw/pull/45318) (merged March 15, 2026) introduced the `inbound_claim` hook infrastructure for plugin-bound conversations. [Issue #48434](https://github.com/openclaw/openclaw/issues/48434) identifies that the same hook only needs to be broadcast to *all* registered plugins (~6 lines in core) to enable the entire listen-only logic as a plugin – no channel-handler modifications needed.

The two approaches are architecturally different. neverReply modifies per-channel providers to write into core `pendingHistory` before mention-gating. Listen-Only claims messages via `inbound_claim` before they reach the provider, maintaining its own Batch-Map with token-budget control, bot filtering, and optional L0/L1 persistence. See [Issue #48434](https://github.com/openclaw/openclaw/issues/48434) for the upstream discussion on the hook broadcast that makes this possible.

### Why not just use pendingHistory?

neverReply writes non-trigger messages into OpenClaw's in-memory `pendingHistory` – a per-provider `Map<groupId, HistoryEntry[]>` that gets flushed into the prompt on the next reply. Fast, zero disk I/O, consistent with the session model.

Listen-Only can't use `pendingHistory` – and doesn't need to. When a plugin claims a message via `inbound_claim` with `{ handled: true }`, the message never reaches the provider code, so `pendingHistory` is never written. Instead, Listen-Only maintains its own **Batch-Map**: a plugin-controlled in-memory buffer that serves the same purpose, but with more control.

| | Core pendingHistory | Listen-Only Batch-Map |
|---|---|---|
| Lives in | Per-channel provider (Telegram, Slack, LINE each have their own) | Plugin-global, per sessionKey |
| Written when | By provider in message handler, before mention-gating | By plugin in `inbound_claim` hook, after gate evaluation |
| Flushed when | Implicitly on next reply (provider builds context, clears history) | Explicitly: time window OR capacity OR on trigger via `before_prompt_build` |
| Injected via | Direct body construction in message context (no hook) | Plugin hook `before_prompt_build` → `prependContext` |
| Overflow | FIFO `shift()` at limit (default 50) | Immediate flush at capacity/window + token truncation (default 2000 tokens) |
| Bot filtering | None – all messages recorded | `ignoreKnownBotIds`, `onlyHumanTriggers`, `isBot` marker |
| Token control | Indirect via historyLimit (message count) | Direct: `maxBatchTokens` with char/4 estimate |
| Persistence | Volatile only | Volatile (batch) + persistent (L0 on disk) |
| On restart | Everything lost | Batch lost, L0 survives |

The Batch-Map is a richer, plugin-controlled replacement for `pendingHistory`. In `storage: memory` mode (L0/L1 disabled), it's functionally equivalent to `pendingHistory` – but with token-budget control, bot filtering, and explicit flush semantics. In `storage: both` mode, L0 additionally persists to disk for long-term recall.

Use case: A teaching assistant bot observes a seminar group chat over a full semester. For the current session, the in-memory batch is enough. But when a student asks next week what was discussed last Tuesday, the bot needs L0/L1 – the in-memory batch will have long been flushed.

## Triggers

| Trigger | What it checks |
|---|---|
| `mention` | Bot name/ID in text or mention entity |
| `owner_voice` | Sender = owner AND message type = voice/audio |
| `owner_image` | Sender = owner AND message type = image |
| `explicit_command` | Message starts with configurable prefix (`!bot`, `/bot`) |

## Configuration reference

```yaml
groupChat:
  listenOnly:
    enabled: true
    forceOff: false              # kill switch for instant rollback

    triggers:
      - mention
      - owner_voice
      - owner_image
      - explicit_command:
          allowFrom: all         # all | owner | allowlist

    rateLimit:
      maxRepliesPerWindow: 10
      windowSeconds: 60

    historyLimit: 200
    compactionThreshold: 150

    silentBatching:
      enabled: true
      windowSeconds: 300
      maxMessages: 50

    memoryExtraction:
      l0:
        enabled: true
        retentionDays: 90
      l1:
        enabled: true
        model: haiku
        strategy: heartbeat
        budgetTokensPerRun: 4000
```

## Project context

Listen-Only was built for a teaching assistant use case: multiple students and a lecturer each have their own OpenClaw agent in a seminar group chat. The bots observe discussions passively, build knowledge over the semester, and answer only when explicitly asked. This requires long-term context retention across weeks – the primary motivation for the L0/L1 memory pipeline.

## Status

Implemented and running in production on a Hetzner CX32 with Telegram group chats. Feedback and contributions welcome.

## License

MIT
