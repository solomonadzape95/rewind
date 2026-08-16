---
name: rewind-forensics
description: Investigate a bad decision made by an agent whose memory lives in CockroachDB — determine whether the cause was bad reasoning or bad memory, find the write that poisoned a belief, price the blast radius, and verify a fix. Use when an agent took a wrong action, when a belief is suspected of being tampered with, or when an audit asks what an agent believed at a past instant.
---

# Rewind forensics

You are investigating an agent that acted wrongly. The memory it read lives in
CockroachDB, and CockroachDB's MVCC has kept every version of every belief for
the length of the GC window. Nothing was logged, because nothing needed to be.

Work through the steps in order. Each consumes only what the previous produced.

## 0. Establish the horizon before anything else

```
GET /api/health
```

Read `retention.gcTtlSeconds`. Every question below is only answerable inside
that window. If the incident is older, say so and stop — do not return a
partial answer that looks complete. A cluster on the 4h default will fail every
question about yesterday while appearing healthy.

## 1. Find the decision

`rewind_timeline` lists every recorded action with its `decision_id` and
`memory_hlc`. The HLC is the exact MVCC coordinate the agent read at — not an
approximation of "around then".

## 2. Rule on it

`rewind_verdict` with the `decision_id`. It replays the decision against the
memory it actually read, several times, and against memory as of now.

| Verdict | What it means | What to do |
|---|---|---|
| `BAD_MEMORY` | The agent applied its memory correctly; the memory was wrong | Go to step 3 |
| `BAD_REASONING` | Memory was correct and the model misused it | Fix the prompt or the model. Stop — there is no write to trace |
| `NON_DETERMINISTIC` | Identical memory produced different actions across runs | Model instability. Memory is exonerated. Stop |
| `RESOLVED` | Corrected memory already yields the right action | The fix is in. Confirm the blast radius is bounded, then stop |
| `REPLAY_UNSOUND` | The prompt or model has drifted since the decision | **Report this and stop.** Do not reason around it. A verdict issued on a changed experiment is not evidence |

`REPLAY_UNSOUND` is not a failure to be worked around. It is the honest answer,
and presenting a guess in its place is the worst thing this tool can do.

## 3. Find the write

`rewind_trace` with the accused belief's `subject`, and `upTo` set to the
decision's `memory_hlc`.

Passing `upTo` matters and is easy to get wrong. Without it the search anchors
at *now*, which answers "how does this belief hold its current value" — a
different question. Anchored at the decision, it answers "how did the belief
this decision read come to hold that value", which is the one being asked.

It returns the prior value, the new value, the bracketing timestamps, and the
source document with its `trust_score`. A rewrite by a *less trusted* source
than the one it replaced is the signature of poisoning; a rewrite by an equally
or more trusted one is probably a legitimate policy update, and you should say
so rather than force an accusation.

## 4. Price it

`rewind_blast_radius` with the trace's `memoryId` and `flippedAt.after` as
`fromHlc`. Omit `toHlc` if the belief has not been corrected yet.

Report the count **and** the dollar exposure. A count alone does not get acted
on.

## 5. Verify the fix (human action)

Remediation is deliberately not an MCP tool. An agent that can rewrite the
belief it has just accused can quietly edit the record it is being audited
against. Hand the operator the commands:

```sh
pnpm rewind fix <subject> "<the prior value the trace recovered>"
pnpm rewind recheck <memory-id> <from-hlc> <fixed-at-hlc>
```

The correction is an ordinary in-place `UPDATE`, so it becomes another MVCC
version — the repair is as auditable as the attack.

## Reporting

Write the finding as an incident report, not a debugging log:

- what the agent believed, and what it should have believed
- which document changed it, through which channel, at what trust level
- when, to the second
- how many other decisions read it while it was wrong, and the total exposure
- whether the fix is verified

State plainly which parts are evidence (replayed, bisected, counted) and which
are inference. If the GC window truncated any part of the answer, say which.
