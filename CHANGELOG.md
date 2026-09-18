# Changelog

## Unreleased

- Queue accepted folds and activate them before the next model request,
  including tool-driven continuations in the same user turn.
- Activate parallel folds together after their tool results enter the model
  transcript.
- Shorten new fold IDs to six base64url characters while retaining lookup
  compatibility with existing IDs.
- Show a configurable TUI success toast after persisted fold activation,
  aggregating parallel folds and reporting their character reduction.

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
