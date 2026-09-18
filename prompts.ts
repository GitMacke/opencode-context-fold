export const foldDescription = `Replace a section of conversation with a concise summary you write. The original text and captured attachments remain available through peek(id).

The user has enabled Context Fold to give you both the tools and responsibility to maintain an efficient working context. You are expected to use fold as part of your workflow whenever a useful summary can replace bulky detail.

Choose the level of detail that serves the current task. Keep low-level detail while working through a problem; once the outcome is understood, fold intermediary steps that no longer contribute to the bigger picture. Preserve what was learned, decided, and remains unresolved. Use peek to consult supporting detail temporarily, or unfold to restore it for ongoing work. Fold earlier summaries into a higher-level account as the work progresses.

Fold proactively during long tasks: after a substantial exploration, debugging attempt, or other phase has produced stable conclusions, fold its raw detail before moving on. Good targets include file reads you have understood, repeated searches, resolved errors, and verbose build or test output. Do not wait until your final answer or until context is nearly full. Keep material you still need verbatim for the next steps.

Preserve conclusions, exact paths and identifiers, user constraints, uncertainties, and unfinished work. Make the summary meaningfully shorter than the selected content. When folding earlier summaries, their IDs remain available in the archived content.

Quote unique start and end anchors exactly from visible message text or tool output. The fold starts at the beginning of the start quote and ends at the end of the end quote. Each quote must come from one continuous block of text; do not stitch together separate messages or outputs. Do not use tool-call arguments or private reasoning as anchors. If a quote is ambiguous, lengthen it.

For every tool call between the anchors, the selection must also contain that call's entire result. If your end quote cuts a result short, move it to the end of that result or later. You may fold just part of a tool result when its call is outside the selection. Ranges cannot cross a compaction checkpoint or select content before one. Correct invalid selections using the returned error.

Independent, non-overlapping folds may run in parallel with each other and with other work. After a successful call, continue your task normally; you can retrieve omitted details with peek whenever needed.`

export const peekDescription = `Return from a fold's high-level summary to its supporting detail. Retrieve the original text and captured attachments by the fold's ID when you need them—for example, to check exact code, wording, or an error. You can peek immediately after folding. This is historical content, not a fresh read of files or external data; private reasoning is not included.

The summary stays in place. Retrieved content is temporary and may be shortened after a later user turn; call peek again when needed. If it contains another fold marker, peek that ID separately for the deeper detail.`

export const unfoldDescription = `Restore the original content of a fold in its original place in the conversation. Use this when a summary missed something important, when the underlying detail needs to stay available for ongoing work, or when you want to reorganize the material into better folds. Use peek instead for a temporary look at supporting detail.

After a successful call, the content returns on the next model request and stays visible until you fold it again or the conversation is compacted. Earlier folds inside the restored section stay folded. The archive remains available through peek. Calling unfold on a pending fold cancels it. If the original content can no longer be restored, use peek to retrieve the archive.`

export const softNudge = `Context is growing. Before moving into the next phase, use fold to summarize completed exploration and bulky results you have already understood. Keep conclusions, exact paths, constraints, and open questions; use peek later for details. Keep anything you still need verbatim, and continue normally if nothing is ready to fold.`

export const strongNudge = `Context is approaching its limit. Before gathering substantial additional information, use fold on completed sections whose raw detail is no longer needed. Preserve conclusions, exact paths, constraints, uncertainties, and unfinished work. The originals remain available through peek. If no section can be usefully shortened yet, continue the task.`
