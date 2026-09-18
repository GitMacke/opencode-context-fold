# Context Fold for OpenCode V2

> [!IMPORTANT]
> This plugin is built specifically for **OpenCode V2** using the `@opencode/plugin`
> V2 API. It does not work with OpenCode V1.

An [OpenCode v2](https://opencode.ai/v2) plugin that lets the model manage its own
working context. It can replace a section of conversation with a summary using
`fold`, consult the original with `peek`, or restore it for ongoing work with
`unfold`. Replacing long stretches of history with short summaries substantially
reduce the input tokens carried into each subsequent request. The recursive
nature of this plugin allows for extremely long sessions with minimal information
loss in a context efficient way.

The model doing the work chooses what to fold and writes the summary. The plugin
archives the original and changes what the model sees on future requests, leaving
stored session history intact.

## Context at different levels of detail

Current work needs detail; older work often needs only enough context to recognize
when it's relevant again. A source document might need its exact wording during
research, a paragraph once its findings are understood, and a brief mention once
the whole project is finished. Folds can themselves be folded, letting the model
build these levels of detail without losing access to the material underneath.

Designing a spaceship might involve separate investigations into propulsion,
power, and life support. Calculations can be folded into component decisions,
then those decisions into subsystem summaries. While working on the rest of the
ship, the propulsion work might be represented by:

> Selected electric propulsion for the cargo ship. Low thrust means longer transit
> times; power requirements must be coordinated with the electrical system.
> Calculations and rejected designs are in the supporting folds.

The model can `peek` to check a calculation or `unfold` the design if the power
budget changes. It can work at the level of the whole ship while keeping a path
back to the details of each component.

The model is responsible for organizing that memory—keeping useful clues in
summaries, preserving open questions, and knowing when to look deeper. Current
frontier models can already do this very efficiently, and the approach will
only get more powerful as their judgment improves. Better organization means
more of a long-running conversation can remain useful within the same finite
context window.

## A fold in practice

```text
Model: fold({
  start:   "Let me look at how the config loader works",
  end:     "so the loader falls back to defaults.",
  summary: "Config loader in src/config.ts reads ~/.app/config.json, validates with zod, falls back to defaults on any error."
})
→ { id: "P5ms2_", status: "pending", applies: "next_model_request", removedChars: 18422 }

… later …

Model: peek({ id: "P5ms2_" })
→ the full original text of that section

… if those details need to stay in context …

Model: unfold({ id: "P5ms2_" })
→ restores the section in its original location on the next model request
```

While the section is folded, the model sees this in place of the original:

```text
[folded P5ms2_] Config loader in src/config.ts reads ~/.app/config.json, validates with zod, falls back to defaults on any error. [/folded]
```

The change takes effect on the next model request, including a continuation after
a tool call in the same user turn. Stored session history is never edited. The
archive remains accessible through `peek` even if later compaction prevents
restoring the section in place.

## Install

Requires OpenCode V2. Tested against 2.0.3.

```sh
opencode plugin add github:GitMacke/opencode-context-fold
```

OpenCode installs the package and its dependencies. Pin a tag or branch with
`#v0.1.0` or `#main` if you want to control updates.

```sh
opencode plugin check                                         # look for updates
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
  "plugins": [
    {
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
    }
  ]
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
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-context-fold",
      "options": { "debug": false }
    }
  ]
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
message text or tool output. The selected section includes both quotes and
everything between them. Each quote must match exactly once; ambiguous matches
return excerpts to help the model choose a longer quote. The plugin checks the
selection immediately and returns a six-character archive ID. Text generated in
the current response becomes selectable on the next model request.

**`peek({ id })`** — returns the archived content of a fold, with role and tool
labels. Images come back as ordinary file attachments. Reasoning is never
archived or returned. The fold stays in place; the retrieved detail is available
through the current response and its tool calls, then shortened after a later
user turn. The model can call `peek` again whenever needed. This retrieves a
historical copy, not a fresh read of a file or external resource.

**`unfold({ id })`** — restores a fold's original content in its original location
on the next model request. Use it to correct a mistaken summary, bring detail
back for ongoing work, or reorganize material into better folds. Restored content
stays visible until folded again or compacted. Inner folds stay folded, and the
archive remains available through `peek`. Unfolding a pending fold cancels it.
If edits or compaction prevent in-place restoration, use `peek` for the archive.

### Proactive folding and reminders

The model is asked to preserve conclusions, exact paths and identifiers, user
constraints, uncertainties, and unfinished work. It should keep material it still
needs verbatim. The tool descriptions and reminder text live in `prompts.ts`.

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

### When changes take effect

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

The TUI shows a toast when folds become active, with the reduction in visible
text. Parallel folds produce one combined notification.

The plugin preserves the unchanged prefix and applies folds from the same tool
batch together to avoid repeated cache invalidation. This matters because input
token savings don't translate directly into cost savings when cached input is
cheaper. Folding or unfolding can cause a cache miss from the changed point
onward; folding pays off by carrying less context through subsequent requests.
Obsolete reasoning and provider replay metadata tied to the old context are
removed.

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

- Each anchor must match exactly once and come from one continuous block of
  message text or tool output. Tool-call arguments are not searchable; whole
  calls may still lie inside a range.
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
- **Provider metadata handling is conservative.** After a rewrite, the plugin
  keeps only known descriptive metadata fields (`phase`, `type`, `status`,
  `result`, `annotations`). Other fields, including reasoning signatures and
  item IDs, are removed because they may refer to the old context.
- **Storage failures degrade, not block.** If plugin storage can't be written
  during activation, the request is served with the previous (un-activated)
  view and activation is retried on the next request. Tool calls still fail if
  their receipt can't be persisted, so retries return the same fold.
- **External media isn't archived.** Only images with captured bytes (data
  URIs or raw buffers) can be folded. URL references are refused rather than
  promising to retrieve a file that may have changed.
- **Native compaction is a boundary.** New folds cannot cross or precede an
  existing compaction checkpoint. The plugin asks the compaction model to keep
  relevant fold IDs and summaries so the archives remain discoverable. That
  model can still omit them. An archive can be retrieved by ID through `peek`,
  but `unfold` cannot restore content behind a checkpoint.

## Future work

Nested folds already let a session retain several levels of detail, but the
structure is still tied to the conversation that produced it. Once native
compaction introduces a checkpoint, earlier material cannot be reorganized in
place. Archives remain accessible through `peek` if their IDs are known, but the
checkpoint summary may omit the references needed to find them.

A longer-term direction is to preserve a navigable memory across those
boundaries: keep older subjects discoverable, retrieve just the relevant level
of detail, and let the model revise how that material is organized. That would
make the approach more useful for a single conversation spanning many projects
or topics.
The aim is to explore this while keeping the model in charge and the set of tools
small.

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
- `prompts.ts` — model-facing tool descriptions and reminders
- `nudge.ts` — context-pressure checks and reminder cooldown

## License

MIT
