# The video

Hard cap **3:00**. They enforce it. This is the single highest-leverage hour of
the whole project — most submissions lose here, not in the code.

**Rules that constrain the cut:** the footage must show the CockroachDB memory
layer at work. That means real SQL on screen, not a diagram of SQL.

**Direction:** no talking-head intro, no logo animation, no "hi, we're team X."
Open on the incident. Every second of preamble is a second not spent on the
memory layer.

---

## Before you record

```sh
pnpm db:reset                     # mandatory — see below
pnpm db:init
pnpm db:seed                      # T+0
# ... let real hours pass ...
pnpm poison                       # T+2h
pnpm dev
```

`db:reset` is not optional. Every rehearsal leaves real MVCC history, and if a
belief held `$5,000` during yesterday's run, bisection has two genuine
transitions to choose between and may trace the wrong incident on camera.

Have a second terminal open, large font, ready to run the SQL shot.

---

## The cut

| Time | Beat | What's on screen | What you say |
|---|---|---|---|
| 0:00–0:15 | **The incident** | The decision row: `approve_refund $4,200`, the rationale, confident and normal | "$4,200 approved. The limit is $500. The logs show a normal, confident approval — nothing to see." |
| 0:15–0:40 | **Rewind the mind** | Drag the scrubber back to the decision. The belief panel flips to **$5,000**. Cut to the terminal: the literal `SELECT ... AS OF SYSTEM TIME <hlc>` running and returning the old value. | "This is what it believed at that instant. Not reconstructed — read. One clause, no audit table, no event log. CockroachDB kept every version for us." |
| 0:40–1:15 | **Verdict** | Hit **Replay**. Three runs against the pinned memory. Verdict card lands on **BAD MEMORY**. | "Same input, same model, same memory it actually read — it makes the same call. The model was fine. The memory was wrong." |
| 1:15–1:50 | **Trace** | Hit **Trace**. Probes stream in, narrowing. Lands on the write, then the S3 document, then the injected sentence highlighted. | "We store no change log. This binary-searches time itself — about twenty probes to pin a seven-day window to the second. Here's the document that did it. Trust score 0.2. It came in through the inbound channel." |
| 1:50–2:20 | **Blast radius** | The count and the dollar figure, large. | "It wasn't one decision. Five others read that belief while it was wrong. Twelve thousand four hundred dollars." |
| 2:20–2:40 | **Fix & re-replay** | Hit **Fix & re-replay**. Rows flip green. | "Restore the value the bisection proved was there, re-run all of them — and they all decide differently. That's memory regression testing, and the fix is itself another MVCC version, so it's as auditable as the attack." |
| 2:40–3:00 | **The close** | `SHOW ZONE CONFIGURATION FROM DATABASE rewind` on screen, `gc.ttlseconds = 604800` visible | "We store no history. Set `gc.ttlseconds` to your regulatory retention window — seven years for a lender — and forensic replay stops being an engineering project and becomes a config value. EU AI Act audit, legal discovery, incident response. One column and one SQL clause." |

Cut. No outro.

---

## The three shots that must be in it

1. **`AS OF SYSTEM TIME` executing in a terminal**, returning the pre-poisoning
   value. Not the UI's rendering of it — the query. This is the required
   "memory layer at work" footage and it is also the single most convincing
   frame in the video.
2. **The probe list narrowing** during the trace. It makes "we binary-search
   time itself" a thing the viewer watched rather than a claim they were told.
3. **`SHOW ZONE CONFIGURATION`** at the close, tying the whole thing to a
   retention policy a compliance officer already understands.

## Lines worth landing verbatim

- "Every observability tool captures what an agent said. None capture what it
  believed."
- "We store no change log — we binary-search time itself."
- "Approximation is fine for recall. It is not fine for evidence."
- "Set `gc.ttlseconds` to your retention requirement and forensic replay becomes
  a config value rather than an engineering project."

## Do not

- Backdate rows to fake a longer incident. A judge who knows MVCC will see
  `updated_at` and the MVCC timestamp disagree, and it discredits you on the one
  criterion you're competing to win. Compress honestly and label it "T+2h".
- Show a decision produced by the `REWIND_OFFLINE=1` stub. It tags itself in the
  rationale for exactly this reason.
- Run over 3:00 to fit one more feature in. Cut the feature.
