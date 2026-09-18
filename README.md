# Context Fold for OpenCode V2

> [!IMPORTANT]
> This plugin is built specifically for **OpenCode V2** using the `@opencode/plugin`
> V2 API. It does not work with OpenCode V1.

An [OpenCode](https://opencode.ai) plugin that lets the model tidy up its own
context window. When a stretch of conversation is finished — an exploration
that's done, a long tool output that's been digested — the model can replace it
with a summary it writes itself. The original is archived and can be pulled
back with a single call.

No second model, no automatic pruning. The model decides what to fold and
what the summary should say.

```
Model: fold({
  start:   "Let me look at how the config loader works",
  end:     "so the loader falls back to defaults.",
  summary: "Config loader in src/config.ts reads ~/.app/config.json, validates with zod, falls back to defaults on any error."
})
→ { id: "P5ms2_", status: "pending", applies: "next_model_request", removedChars: 18422 }

… later …

Model: peek({ id: "P5ms2_" })
→ the full original text of that section
```

From the next model request onward, including a tool-driven continuation in the
same user turn, the model sees this in place of the original:

```
[folded P5ms2_] Config loader in src/config.ts reads ~/.app/config.json, validates with zod, falls back to defaults on any error. [/folded]
```

## Why

Long agentic sessions fill up with detail that was essential five minutes ago
and is noise now: directory listings, file contents that have since been
edited, dead-end investigations. Built-in compaction handles this by having a
model summarize *everything* at once when the window is nearly full, which is
lossy and happens at the worst possible moment.

Folding is incremental and voluntary. The model summarizes a section while it
still remembers what mattered, keeps the rest of the context untouched, and can
always get the original back. Session history on disk is never modified; only
what the model is shown changes.

## Install

Requires OpenCode V2. Tested against 2.0.3.

```sh
opencode plugin add github:GitMacke/opencode-context-fold
```

OpenCode installs the package and its dependencies. Pin a tag or branch with
`#v0.1.0` or `#main` if you want to control updates.

```sh
opencode plugin check                                          # look for updates
opencode plugin update github:GitMacke/opencode-context-fold   # apply them
opencode plugin remove github:GitMacke/opencode-context-fold   # uninstall
```

### Disable

Prefix the plugin ID with `-` in `opencode.jsonc`, globally
(`~/.config/opencode/opencode.jsonc`) or in a single project:

```jsonc
{
  "plugins": ["-context-fold"]
}
```

Remove the entry to re-enable. Fold state stays in plugin storage either way.

### Options

```jsonc
// opencode.jsonc
{
  "plugins": [{
    "package": "github:GitMacke/opencode-context-fold",
    "options": {
      "debug": false,
      // Remind the model to fold as its context grows.
      "nudges": true,
      // Show a success toast when queued folds become active.
      "notifications": {
        "enabled": true,
        "duration": 4000
      }
    }
  }]
}
```

- `debug` (default `false`): write the before/after transcript of every model
  request to `$TMPDIR/opencode-context-fold/<sessionID>.json`. Useful when
  diagnosing a fold that didn't apply. **These files contain the full
  conversation.**
- `notifications` (default enabled): show a TUI success toast when folds become
  active, with the exact character reduction and its share of the preceding
  visible context. Parallel folds produce one combined toast. Set this to
  `false` to disable notifications, or set `enabled` and `duration` (milliseconds)
  in the object form shown above.
- `nudges` (default `true`): add a brief model-facing reminder at 60% of the
  model's context limit, with stronger wording at 80%. Set to `false` to disable.

### Local checkout

To test an existing checkout directly, replace the published package entry with
its absolute directory in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/opencode-context-fold",
    "options": { "debug": false }
  }]
}
```

Run `bun install` in the checkout, then restart OpenCode's service after source
changes with `opencode service restart`. Do not keep the GitHub package entry at
the same time, or two copies of the plugin will load.

Alternatively, clone into OpenCode's global plugin directory. Plugins there are
discovered automatically and are not managed by `opencode plugin`.

```sh
git clone https://github.com/GitMacke/opencode-context-fold ~/.config/opencode/plugins/context-fold
cd ~/.config/opencode/plugins/context-fold
bun install
```

Don't combine this with the `opencode plugin add` install; you'd load two copies.

## How it works

### Tools

**`fold({ start, end, summary })`** — `start` and `end` are exact quotes from
visible conversation text (message prose or tool output). Each must match
exactly once; if not, the error tells you how many matches there are and shows
excerpts so you can lengthen the quote. The selection is inclusive of both
anchors and may span many messages, including whole tool calls with their
results, reasoning blocks, and images. The fold is validated immediately and
returns a six-character ID.

**`peek({ id })`** — returns the archived content of a fold, with role and tool
labels. Images come back as ordinary file attachments. Reasoning is never
archived or returned. Peek results are themselves shortened on the next user
turn to keep the tail of the context small; call `peek` again if you need it
back.

**`unfold({ id })`** — restores a fold's original content in its original location
on the next model request. Use it to correct a mistaken summary, bring detail
back for ongoing work, or reorganize material into better folds. Restored content
stays visible until folded again or compacted. Inner folds stay folded, and the
archive remains available through `peek`. Unfolding a pending fold cancels it.
If edits or compaction prevent in-place restoration, use `peek` for the archive.

### Proactive folding and reminders

The tool descriptions encourage folding after substantial exploration or other
completed phases, rather than waiting until the final answer. They emphasize
what to preserve and how to retrieve details, leaving implementation mechanics
out of the model's instructions. The wording lives in `prompts.ts`.

Reminders use the latest reported usage for the current model, including cached,
output, and reasoning tokens. This is a lagging pressure signal, not an exact
token count of the outgoing request; newly added tool output is not yet counted.
No tokenizer or extra model call is used. If usage or the context limit is
unavailable, no reminder is added.

Reminders are temporary system instructions, only on ordinary context requests
where `fold` is available. They skip four fresh model responses between repeats,
but can escalate immediately from the soft to the strong reminder. A successful
fold starts a cooldown and suppresses the old usage reading. Usage from before
native compaction or a model switch is ignored. No reminder is saved in session
history, and nudges never choose or fold content automatically.

### Lifecycle

```
fold() called ──► queued ──► (next model request) ──► active
                     │                                    │
                     └─► failed (source changed, or       └─► visible as [folded ID] marker
                          checkpoint appeared)                 until unfolded or compacted
```

A fold cannot change a model request that is already in flight. It is queued
when the tool succeeds, then activates as soon as safely possible: before the
next model request, including a tool-driven continuation in the same user turn.
Parallel folds from one tool batch activate together. If there is no
continuation, the fold naturally waits for the next user turn.

Unfolding an active fold uses the same next-request boundary and persistence
guarantees. The original source is restored with its message roles, tool pairs,
and attachments intact. Obsolete reasoning and provider replay signatures stay
retired; unfolding also invalidates replay state generated against the folded
view. A pending fold can be cancelled immediately because it has not changed the
model-visible context yet. Fold and unfold archives and receipts survive reloads.

On activation, the bundled TUI companion shows one non-blocking success toast
with the reduction in visible text. Notifications are emitted only after the
new fold state is persisted; notification delivery is best-effort and cannot
block folding or model dispatch.

Providers sign reasoning blocks against the exact history they saw. Activation
therefore strips replay state generated against the old view before dispatching
the rewritten request.

Activation strips the replay signatures from the reasoning that was generated
against the old view (from the first affected message onward) and drops the
obsolete reasoning blocks themselves. Visible text, tool calls, and results
are all kept. This costs a prompt-cache miss from the fold point forward —
batching several folds before a turn ends is cheaper than folding one at a
time across turns.

### Addressing and replay

Folds are stored as stable `(message, part, offset)` ranges plus a SHA-256
digest of the selected content, not as the quoted strings. On every request the
plugin replays the fold log onto the current transcript and verifies the
digest. If the source has changed — an edited message, an upstream transform,
native compaction — the fold is skipped and its archive stays available through
`peek`. Quotes are never re-searched, so appending a duplicate of an old
passage later can't shift an earlier fold.

Folds can nest: fold a region that contains an earlier marker, and the outer
archive contains the inner marker. Peeking the outer fold reveals the inner ID.
Unfolding the outer fold restores the inner marker in place. If an unfold cannot
find its complete marker, it returns an error without changing other folds.

### Selection rules

- Each anchor must match exactly once in visible text and lie within a single
  text part. Tool-call arguments are not searchable; whole calls may still lie
  inside a range.
- A range cannot cross a provider checkpoint (native compaction summary); the
  error quotes the text just before the checkpoint. A fold also can't be placed
  before an existing checkpoint. System messages inside a range are kept in
  place and are not archived.
- If a range includes a tool call, it must include that call's entire result.
  Folding only a result (leaving the call outside) is allowed; the result
  envelope is kept with the summary as its content.
- The summary plus marker must be shorter than the selected text, unless the
  range removes an image.
- Non-overlapping folds from one batch of parallel tool calls all resolve
  against the same snapshot. Overlapping ones fail rather than silently
  clobber each other.

### Storage

Per-session state (fold log, archives, tool-call receipts, activation records)
lives in OpenCode's plugin storage. Tool results are acknowledged only after
persistence succeeds, so a retried call returns the existing fold rather than
creating a duplicate. Forked sessions don't inherit folds.

## Limitations

- **No in-flight activation.** A fold cannot shrink the model request that
  produced its tool call. Savings begin with the next model request. If the
  session becomes idle without another request, the fold remains queued and the
  existing context indicator will not reflect its eventual savings yet.
- **Cache miss on activation.** Every activation invalidates the provider
  prompt cache from the earliest changed point forward. Unfolding does too.
- **Provider replay metadata is allow-listed, not understood.** When history
  before a part changes, its `providerMetadata` is reduced to fields that
  describe the part itself (`phase`, `type`, `status`, `result`,
  `annotations`); everything else is assumed to be replay state such as
  reasoning signatures or item IDs. This was verified against every protocol in
  `@opencode/ai` 2.0.3 and fails safe: an unknown provider's signature field is
  dropped and the part replays as fresh, rather than being sent and rejected.
  OpenCode has no shared helper for this yet; if one appears, use it.
- **Storage failures degrade, not block.** If plugin storage can't be written
  during activation, the request is served with the previous (un-activated)
  view and activation is retried on the next request. Tool calls still fail if
  their receipt can't be persisted, so retries return the same fold.
- **External media isn't archived.** Only images with captured bytes (data
  URIs or raw buffers) can be folded. URL references are refused rather than
  promising to retrieve a file that may have changed.
- **Native compaction is a boundary.** Folds on either side of a compaction
  checkpoint work; folds spanning one don't. The compaction hook shows the
  summarizer the folded transcript and appends a system instruction asking it
  to copy `[folded ID]` markers into the checkpoint verbatim so `peek` still
  works afterward. This is best-effort: nothing forces the summarizer to comply.

## Development

```sh
bun install
bun run check      # typecheck + lint + tests
bun run format     # biome
```

Layout:

- `core.ts` — view/piece model, anchor resolution, fold application, rendering
- `lifecycle.ts` — session state, turn-boundary detection, activation
- `index.ts` — plugin registration, tool definitions, hooks

## License

MIT
