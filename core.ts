// Pure fold algebra. A transcript is turned into a View: a flat list of Blocks,
// one per message part, each holding Pieces of text addressed by a stable
// (source, offset) pair. Folds are resolved against a View, stored as
// source-addressed ranges plus a content digest, and replayed onto later
// transcripts without re-searching quotes. Nothing here touches storage or
// the plugin API.
import { createHash } from "node:crypto"
import { type ContentPart, Message } from "@opencode/ai"

// Source offsets refer to immutable pieces, not offsets in the shrinking prompt.
// A second fold can select an untouched suffix or an earlier fold's marker.
interface Piece {
  source: string
  offset: number
  text: string
}

interface Block {
  key: string
  message: Message
  messageKey: string
  part: ContentPart
  pieces: Piece[]
  opaque: boolean
  changed: boolean
}

export type View = Block[]
interface Point {
  source: string
  offset: number
}
export interface Fold {
  id: string
  summary: string
  start: Point
  end: Point
  digest: string
  original: string
  removedChars: number
  content?: ArchiveContent[]
}

export type ArchiveContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string }

export interface FoldInput {
  start: string
  end: string
  summary: string
}
export class FoldError extends Error {}

export function sameFold(left: Fold, right: Fold): boolean {
  return (
    left.digest === right.digest &&
    left.summary === right.summary &&
    left.start.source === right.start.source &&
    left.start.offset === right.start.offset &&
    left.end.source === right.end.source &&
    left.end.offset === right.end.offset
  )
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

// Identity for source addressing and digests. Must be stable across providers:
// OpenCode renders the same history differently per target (foreign signed
// reasoning is dropped, providerMetadata differs), so neither part index nor
// provider metadata can take part. Media bytes are summarized by length.
function partIdentity(part: ContentPart): unknown {
  const { providerMetadata: _, ...rest } = part as ContentPart & { providerMetadata?: unknown }
  if (rest.type !== "media") return rest
  const { data, ...media } = rest
  return { ...media, data: typeof data === "string" ? data : { bytes: data.byteLength } }
}

function partText(part: ContentPart): string | undefined {
  if (part.type === "text") return part.text
  if (part.type === "tool-call") return `${part.name}(${JSON.stringify(part.input)})`
  if (part.type !== "tool-result") return undefined
  const result = part.result
  if (result.type === "content") {
    // A textual fold must not quietly discard attachments.
    if (result.value.some((item) => item.type !== "text")) return undefined
    return result.value.map((item) => (item.type === "text" ? item.text : "")).join("\n")
  }
  return typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? "null")
}

export function createView(messages: readonly Message[]): View {
  const occurrences = new Map<string, number>()
  return messages.flatMap((message) => {
    // IDs are optional in the public hook. A content fingerprint is a conservative
    // fallback: an edited/idless message won't accidentally inherit an old fold.
    const identity = message.id ?? hash([message.role, message.content.map(partIdentity)])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    const messageKey = `${identity}:${occurrence}`
    const seen = new Map<string, number>()
    return message.content.map((part) => {
      const text = partText(part)
      const fingerprint = hash(partIdentity(part))
      const repeat = seen.get(fingerprint) ?? 0
      seen.set(fingerprint, repeat + 1)
      const source = hash([messageKey, fingerprint, repeat])
      return {
        key: source,
        message,
        messageKey,
        part,
        pieces: text === undefined ? [] : [{ source, offset: 0, text }],
        opaque: text === undefined || message.role === "system",
        changed: false,
      }
    })
  })
}

function text(block: Block): string {
  return block.pieces.map((piece) => piece.text).join("")
}

export function viewChars(view: View): number {
  return view.reduce((total, block) => total + text(block).length, 0)
}

interface Position {
  block: number
  offset: number
}

function pointAt(block: Block, offset: number, end: boolean): Point {
  let cursor = 0
  for (const piece of block.pieces) {
    const limit = cursor + piece.text.length
    if (offset >= cursor && (end ? offset > cursor && offset <= limit : offset < limit)) {
      return { source: piece.source, offset: piece.offset + offset - cursor }
    }
    cursor = limit
  }
  throw new FoldError("Anchor does not identify a text boundary.")
}

function locate(view: View, point: Point, end: boolean): Position {
  for (let block = 0; block < view.length; block++) {
    let offset = 0
    for (const piece of view[block].pieces) {
      const local = point.offset - piece.offset
      if (
        piece.source === point.source &&
        (end ? local > 0 && local <= piece.text.length : local >= 0 && local < piece.text.length)
      ) {
        return { block, offset: offset + local }
      }
      offset += piece.text.length
    }
  }
  throw new FoldError("Selection is no longer visible (overlap, edit, or compaction). Select a fresh range.")
}

function anchor(view: View, value: string, label: string): { start: Position; end: Position } {
  if (!value.trim()) throw new FoldError(`${label} must contain non-whitespace text.`)
  const matches: { start: Position; end: Position; excerpt: string }[] = []
  view.forEach((block, index) => {
    // Anchors quote visible prose/results, never guessed tool JSON or reasoning.
    if (block.opaque || block.part.type === "tool-call") return
    const raw = text(block)
    for (let at = raw.indexOf(value); at !== -1; at = raw.indexOf(value, at + 1)) {
      matches.push({
        start: { block: index, offset: at },
        end: { block: index, offset: at + value.length },
        excerpt: raw.slice(Math.max(0, at - 40), Math.min(raw.length, at + value.length + 40)),
      })
    }
  })
  if (!matches.length)
    throw new FoldError(
      `${label} quote not found. Copy an exact quote from message text or tool output already present before this response. Text you just wrote becomes selectable on the next model request.`,
    )
  if (matches.length !== 1)
    throw new FoldError(
      `${label} has ${matches.length} matches. Lengthen it to be unique. Examples: ${JSON.stringify(matches.slice(0, 3).map((match) => match.excerpt))}`,
    )
  return matches[0]
}

function slicePieces(pieces: Piece[], from: number, to: number): Piece[] {
  let cursor = 0
  return pieces.flatMap((piece) => {
    const start = Math.max(0, from - cursor)
    const end = Math.min(piece.text.length, to - cursor)
    cursor += piece.text.length
    return end <= start
      ? []
      : [{ ...piece, offset: piece.offset + start, text: piece.text.slice(start, end) }]
  })
}

function selection(view: View, start: Position, end: Position) {
  if (start.block > end.block || (start.block === end.block && start.offset >= end.offset))
    throw new FoldError("end must follow start.")
  const selected = view.slice(start.block, end.block + 1)
  const checkpoint = selected.findIndex((block) => block.part.type === "compaction")
  if (checkpoint >= 0) {
    const before = selected.slice(0, checkpoint).findLast((block) => !block.opaque)
    const where = before ? `right after ${JSON.stringify(text(before).slice(-60))}` : "at the selection start"
    throw new FoldError(`Range crosses a provider checkpoint ${where}. Fold on either side of it.`)
  }
  // System messages are privileged instructions: they stay in place inside a
  // folded range instead of acting as boundaries, and are not part of the fold.
  const pieces = selected.map((block, index) => ({
    block,
    keep: block.message.role === "system",
    from: index === 0 ? start.offset : 0,
    to: index === selected.length - 1 ? end.offset : text(block).length,
  }))
  // Removing a call requires its complete result. Result-only folds retain the
  // result envelope, so a call outside the selection stays protocol-valid.
  for (const item of pieces) {
    const part = item.block.part
    if (part.type !== "tool-call") continue
    const result = pieces.find(
      (other) => other.block.part.type === "tool-result" && other.block.part.id === part.id,
    )
    if (result?.from !== 0 || result.to !== text(result.block).length) {
      throw new FoldError(
        `Range splits ${part.name}'s call/result pair. Extend end through the complete result, or start after the call.`,
      )
    }
  }
  // Reasoning is excluded from the digest: OpenCode omits foreign providers'
  // signed reasoning from the transcript, so its presence is not stable.
  const folded = pieces.filter((item) => !item.keep)
  const content = folded
    .filter(({ block }) => block.part.type !== "reasoning")
    .map(({ block, from, to }) => ({
      role: block.message.role,
      type: block.part.type,
      tool:
        block.part.type === "tool-call" || block.part.type === "tool-result"
          ? { id: block.part.id, name: block.part.name }
          : undefined,
      text: text(block).slice(from, to),
      ...(block.opaque ? { opaque: hash(partIdentity(block.part)) } : {}),
    }))
  const archive = folded.flatMap(({ block, from, to }): ArchiveContent[] => {
    const part = block.part
    // Private reasoning is protocol state, not peekable conversation text.
    if (part.type === "reasoning") return []
    const label: ArchiveContent = {
      type: "text",
      text: `[${block.message.role}${part.type === "tool-call" || part.type === "tool-result" ? ` ${part.name} ${part.type}` : ""}]`,
    }
    if (part.type === "media") return [label, mediaFile(part)]
    if (block.opaque && part.type === "tool-result" && part.result.type === "content") {
      return [
        label,
        ...part.result.value.map((item) => {
          if (item.type === "file" && !item.uri.startsWith("data:")) {
            throw new FoldError(
              "Attachment is an external reference, not captured data. This POC only archives self-contained media.",
            )
          }
          return item
        }),
      ]
    }
    return [{ type: "text", text: `${label.text}\n${text(block).slice(from, to)}` }]
  })
  return {
    pieces,
    digest: hash(content),
    original: archive
      .map((item) => (item.type === "text" ? item.text : `[attachment ${item.name ?? item.mime}]`))
      .join("\n\n"),
    archive,
    chars: content.reduce((total, item) => total + item.text.length, 0),
  }
}

function mediaFile(part: Extract<ContentPart, { type: "media" }>): ArchiveContent {
  if (typeof part.data === "string" && /^(?:https?|file):/i.test(part.data)) {
    throw new FoldError("Media must contain captured bytes, not an external reference.")
  }
  const data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64")
  return {
    type: "file",
    uri: data.startsWith("data:") ? data : `data:${part.mediaType};base64,${data}`,
    mime: part.mediaType,
    ...(part.filename ? { name: part.filename } : {}),
  }
}

export function prepareFold(view: View, input: FoldInput, attempt = 0): Fold {
  if (!input.summary.trim()) throw new FoldError("summary must be non-empty.")
  const start = anchor(view, input.start, "start").start
  const end = anchor(view, input.end, "end").end
  const selected = selection(view, start, end)
  const summary = input.summary.trim()
  const first = pointAt(view[start.block], start.offset, false)
  const last = pointAt(view[end.block], end.offset, true)
  const id = Buffer.from(hash([first, last, selected.digest, summary, attempt]), "hex")
    .toString("base64url")
    .slice(0, 6)
  const removedChars = selected.chars - marker({ id, summary }).length
  const hasMedia = selected.archive.some((item) => item.type === "file")
  if (removedChars <= 0 && !hasMedia)
    throw new FoldError(
      "Summary plus marker is not shorter than the selection. Fold a larger range or write a shorter summary.",
    )
  return {
    id,
    summary,
    start: first,
    end: last,
    digest: selected.digest,
    original: selected.original,
    removedChars: Math.max(0, removedChars),
    ...(hasMedia ? { content: selected.archive } : {}),
  }
}

function marker(fold: Pick<Fold, "id" | "summary">): string {
  return `[folded ${fold.id}] ${fold.summary} [/folded]`
}

export function applyFold(view: View, fold: Fold): View {
  const start = locate(view, fold.start, false)
  const end = locate(view, fold.end, true)
  const selected = selection(view, start, end)
  if (selected.digest !== fold.digest)
    throw new FoldError("Selection changed since it was requested. Retry with fresh anchors.")
  const removedCalls = new Set(
    selected.pieces.flatMap(({ block }) => (block.part.type === "tool-call" ? [block.part.id] : [])),
  )
  const replacement = selected.pieces.flatMap(({ block, keep, from, to }, index): Block[] => {
    if (keep) return [block]
    const part = block.part
    if (
      part.type === "reasoning" ||
      part.type === "media" ||
      part.type === "tool-call" ||
      (part.type === "tool-result" && removedCalls.has(part.id))
    )
      return []
    const pieces = [
      ...slicePieces(block.pieces, 0, from),
      ...(index === 0 ? [{ source: `fold:${fold.id}`, offset: 0, text: marker(fold) }] : []),
      ...slicePieces(block.pieces, to, text(block).length),
    ]
    if (!pieces.length && part.type !== "tool-result") return []
    // Empty result envelopes are intentional; the summary at the start covers them.
    return [{ ...block, pieces, changed: true }]
  })
  return [...view.slice(0, start.block), ...replacement, ...view.slice(end.block + 1)]
}

export function render(view: View): Message[] {
  const groups: { message: Message; key: string; content: ContentPart[]; changed: boolean }[] = []
  for (const block of view) {
    let group = groups.at(-1)
    if (!group || group.key !== block.messageKey) {
      group = { message: block.message, key: block.messageKey, content: [], changed: false }
      groups.push(group)
    }
    group.changed ||= block.changed
    if (!block.changed) group.content.push(block.part)
    else if (block.part.type === "text")
      group.content.push({
        ...block.part,
        providerMetadata: cleanMetadata(block.part.providerMetadata),
        text: text(block),
      })
    else if (block.part.type === "tool-result") {
      const { providerMetadata: _, metadata: __, ...part } = block.part
      group.content.push({ ...part, result: { type: "text", value: text(block) } })
    }
  }
  return groups.map(({ message, content, changed }) => {
    if (
      !changed &&
      content.length === message.content.length &&
      content.every((part, index) => part === message.content[index])
    )
      return message
    const { native: _, ...rest } = message
    return Message.make({ ...rest, providerMetadata: cleanMetadata(message.providerMetadata), content })
  })
}

// providerMetadata is { [provider]: { [field]: value } }. Once history before a
// part has changed, only fields describing the part itself are kept; everything
// else is treated as replay state (signatures, item IDs, encrypted reasoning)
// that ties the part to the earlier transcript. Allow-listing means an
// unfamiliar provider's signature field is dropped and the part replays as
// fresh, rather than surviving and being rejected. The opaque payloads
// themselves are never edited.
//
// Fields every @opencode/ai 2.0.3 protocol reads back from non-reasoning parts:
//   phase, type, status  open-responses message/part semantics
//   result               anthropic server-tool result payload
//   annotations          meta-responses citations
const semanticFields = new Set(["phase", "type", "status", "result", "annotations"])
function cleanMetadata<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([provider, fields]) => [
      provider,
      fields && typeof fields === "object" && !Array.isArray(fields)
        ? Object.fromEntries(Object.entries(fields).filter(([key]) => semanticFields.has(key)))
        : fields,
    ]),
  ) as T
}

export interface Reset {
  // Stable source identities, not an open-ended chronological cutoff.
  retired: string[]
  cleaned: string[]
}

export function resetFrom(view: View, index: number): Reset {
  if (index >= view.length) return { retired: [], cleaned: [] }
  // Include preceding reasoning in the first reconstructed assistant message.
  const messageKey = view[index].messageKey
  while (index > 0 && view[index - 1].messageKey === messageKey) index--
  const tail = view.slice(index)
  return {
    retired: tail.filter((block) => block.part.type === "reasoning").map((block) => block.key),
    cleaned: tail.filter((block) => block.part.type !== "reasoning").map((block) => block.key),
  }
}

export function foldStart(view: View, fold: Fold): number {
  return locate(view, fold.start, false).block
}

export function markerStart(view: View, fold: Fold): number {
  const index = view.findIndex((block) =>
    block.pieces.some(
      (piece) => piece.source === `fold:${fold.id}` && piece.offset === 0 && piece.text === marker(fold),
    ),
  )
  if (index < 0)
    throw new FoldError(
      `Fold ${fold.id} exists, but its marker is not available in the current context. Use peek to inspect its archive temporarily. If it is inside another fold, unfold that fold first to restore it in place.`,
    )
  return index
}

export function resetView(view: View, reset: Reset): View {
  const retired = new Set(reset.retired),
    cleaned = new Set(reset.cleaned)
  return view.flatMap((block): Block[] => {
    if (retired.has(block.key) && block.part.type === "reasoning") return []
    if (!cleaned.has(block.key) || block.part.type === "compaction") return [block]
    const { native: _, ...message } = block.message
    return [
      {
        ...block,
        message: Message.make({ ...message, providerMetadata: cleanMetadata(message.providerMetadata) }),
        part: { ...block.part, providerMetadata: cleanMetadata(block.part.providerMetadata) },
      },
    ]
  })
}

export function collapsePeekView(view: View, calls: string[]): View {
  const targets = new Set(calls)
  return view.map((block) => {
    if (block.part.type !== "tool-result" || !targets.has(block.part.id)) return block
    return {
      ...block,
      opaque: false,
      changed: true,
      pieces: [
        { source: `peek:${block.part.id}`, offset: 0, text: "[peeked content; call peek again to retrieve]" },
      ],
    }
  })
}

export function peekStart(view: View, calls: string[]): number {
  const targets = new Set(calls)
  const index = view.findIndex((block) => block.part.type === "tool-result" && targets.has(block.part.id))
  return index < 0 ? view.length : index
}

export function hasCheckpointAfter(view: View, index: number): boolean {
  return view.slice(index).some((block) => block.part.type === "compaction")
}
