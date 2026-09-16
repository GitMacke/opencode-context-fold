# Changelog

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
