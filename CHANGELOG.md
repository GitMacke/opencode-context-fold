# Changelog

## 0.2.0

- Requires OpenCode 2.0.29 or newer. Stay on 0.1.1 for older versions.
- Support OpenCode 2.0.29: load `@opencode/ai` for types only, since plugins
  may only use the host's `effect` and `@opencode/plugin` at runtime; adopt the
  `Media.Asset` media parts.
- Count each archived image or attachment as 4,000 characters when sizing a
  fold, so small selections with images fold and report realistic savings.
- Queue accepted folds and activate them before the next model request,
  including tool-driven continuations in the same user turn.
- Activate parallel folds together after their tool results enter the model
  transcript.
- Shorten new fold IDs to six base64url characters while retaining lookup
  compatibility with existing IDs.
- Show a configurable TUI success toast after persisted fold activation,
  aggregating parallel folds and reporting their character reduction.
- List active folds that compaction or other rewrites made undiscoverable in a
  persisted notice at the end of the next request, so their archives stay
  reachable through `peek`. Nested folds are covered through their outer fold.
- Replace the 60%/80% context-limit nudges with a reminder after every
  `nudges.every` tokens (default 50,000) of growth without a fold, saved as a
  session notice at the end of the request instead of a temporary system
  prompt addition, preserving the cache.
- Exclude `fold` tool results from anchor matching, so a retry after a failed
  fold is not ambiguous with the echoed arguments.
- Include activation and unfold error notices in the current request, and keep
  serving the request if a notice cannot be persisted.

## 0.1.0

Initial public release for OpenCode V2.

- `fold` and `peek` tools; folds activate at the next real user turn.
- Stable source-addressed ranges with content digests; folds survive reloads
  and are skipped rather than misapplied when the transcript changes.
- Reasoning reset on activation so provider replay signatures stay consistent.
- System messages inside a range stay in place; provider compaction
  checkpoints are hard boundaries.
- Source identities are provider-neutral (no part index or provider metadata),
  so folds survive switching models mid-session.
- Storage failures during activation degrade to the previous view instead of
  blocking the request.
