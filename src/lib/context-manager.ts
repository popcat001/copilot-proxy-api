/**
 * Chat history is preserved by default. Oversized payloads return a prompt-too-long
 * error so the client can compact. Lossy byte/token-based reduction is opt-in.
 */

import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getKnownModelPromptLimit } from "./model-limits"
import { createPromptTooLongError } from "./prompt-too-long"
import { state } from "./state"

// ── Configuration ───────────────────────────────────────────────────────────

/** Existing transport backstop; distinct from upstream token limits. */
export const MAX_PAYLOAD_BYTES = 5_000_000

/** Conservative ceiling for custom Claude Code aliases / effort modes that do
 *  not appear in Copilot model metadata. Copilot can hang for minutes in the
 *  2.5-5 MB range, so unknown models stay below that dead zone. */
export const UNKNOWN_MODEL_PAYLOAD_BYTES = 1_900_000

/** Minimum protected byte budget for recent tool outputs before pruning. */
const PRUNE_PROTECT_BYTES = 200_000

/** Don't prune unless we'd reclaim at least this many bytes. */
const PRUNE_MINIMUM_BYTES = 50_000

/** Per-message hard cap for tool output content even when "recent". A single
 *  giant Read of a 1MB file shouldn't blow the budget by itself. */
const TOOL_OUTPUT_HARD_CAP = 100_000

/**
 * Empirical chars/token ratio for Claude Code payloads. Used to derive a
 * byte ceiling from the model's `max_prompt_tokens` without paying for a
 * real tokenizer pass. Real ratios on typical code-heavy Claude Code traffic
 * sit in the 3.0-3.8 range (English prose ~4.0, dense code ~3.0). We pick
 * 3.5 as a slightly conservative midpoint — it errs toward pruning a touch
 * earlier rather than letting Copilot reject. Cost: one multiplication per
 * request vs. ~300-1000ms for a real tokenizer pass on the hot path.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3.5

/**
 * Reserve this many tokens under max_prompt_tokens for max_tokens output and
 * Copilot framing overhead (function-call encoding, message-wrapping tokens).
 * Copilot's reported prompt_token count typically runs a few thousand higher
 * than ours due to encoding differences; this buffer absorbs that skew.
 */
const TOKEN_RESERVE = 8_000

const PRUNED_PLACEHOLDER = "[content pruned — tool output was too old]"
const TOOL_TRUNCATED_SUFFIX = "\n\n[…tool output truncated to fit context]"
const IMAGE_STRIPPED_PLACEHOLDER = "[image removed to save context]"

// ── Public API ──────────────────────────────────────────────────────────────

/** Legacy token-derived budget, used only for opt-in trimming. */
function computeEffectiveCeiling(model: Model): number {
  const maxPromptTokens = getKnownModelPromptLimit(
    model.id,
    model.capabilities.limits,
  )
  if (!maxPromptTokens) return MAX_PAYLOAD_BYTES
  const tokenDerivedBytes = Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
  return Math.max(1, Math.min(MAX_PAYLOAD_BYTES, tokenDerivedBytes))
}

/**
 * Fit a payload within the model's effective byte ceiling. Returns the input
 * payload unmodified in the common case (cheap byte size check).
 */
export function fitContext(
  payload: ChatCompletionsPayload,
  model: Model,
): ChatCompletionsPayload {
  const ceiling =
    state.chatContextTrim ? computeEffectiveCeiling(model) : MAX_PAYLOAD_BYTES
  return fitPayloadToCeiling(payload, ceiling)
}

export function fitUnknownModelContext(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return fitPayloadToCeiling(payload, UNKNOWN_MODEL_PAYLOAD_BYTES)
}

export function isPayloadOverUnknownModelCeiling(
  payload: ChatCompletionsPayload,
): boolean {
  return estimatePayloadBytes(payload) > UNKNOWN_MODEL_PAYLOAD_BYTES
}

function fitPayloadToCeiling(
  payload: ChatCompletionsPayload,
  ceiling: number,
): ChatCompletionsPayload {
  const initialBytes = estimatePayloadBytes(payload)

  // Fast path: well under the effective ceiling — just send.
  if (initialBytes <= ceiling) {
    return payload
  }

  consola.info(
    `Context fit: payload ${formatBytes(initialBytes)} exceeds ${formatBytes(ceiling)} ceiling — ${state.chatContextTrim ? "reducing" : "requesting client compaction"}`,
  )

  if (!state.chatContextTrim) {
    throw createPromptTooLongError(payload, initialBytes, ceiling)
  }

  // Slow path: progressive byte-based reduction.
  let current = pruneToolOutputs(payload)
  let bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.info(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after tool pruning`,
    )
    return current
  }

  current = stripOldImages(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.info(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after stripping old images`,
    )
    return current
  }

  // Aggressive: strip ALL images regardless of age.
  current = stripAllImages(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.warn(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after stripping ALL images`,
    )
    return current
  }

  // Truncate any oversized tool outputs that survived pruning (e.g. recent ones).
  current = truncateOversizedToolOutputs(current)
  bytes = estimatePayloadBytes(current)
  if (bytes <= ceiling) {
    consola.warn(
      `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after truncating oversized tool outputs`,
    )
    return current
  }

  current = dropOldMessages(current, ceiling)
  bytes = estimatePayloadBytes(current)
  consola.warn(
    `Context fit: ${formatBytes(initialBytes)} → ${formatBytes(bytes)} after dropping old messages`,
  )
  if (bytes > ceiling) {
    throw createPromptTooLongError(payload, bytes, ceiling)
  }
  return current
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(2)}MB`
}

// ── Byte estimation ─────────────────────────────────────────────────────────

/** Actual serialized UTF-8 bytes, including JSON escaping and framing. */
function estimatePayloadBytes(payload: ChatCompletionsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8")
}

function estimateMessageBytes(msg: Message): number {
  let bytes = 40 // role + framing
  if (typeof msg.content === "string") {
    bytes += msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if ("text" in part && typeof part.text === "string") {
        bytes += part.text.length + 20
      } else if ("type" in part && part.type === "image_url") {
        bytes += part.image_url.url.length + 40
      }
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      bytes += tc.function.name.length + tc.function.arguments.length + 80
    }
  }
  if (msg.tool_call_id) bytes += msg.tool_call_id.length + 20
  if (msg.reasoning_text) bytes += msg.reasoning_text.length + 20
  if (msg.reasoning_opaque) bytes += msg.reasoning_opaque.length + 20
  return bytes
}

// ── Reduction step 1: prune old tool outputs ────────────────────────────────

function pruneToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages
  let protectedBytes = 0
  let prunedBytes = 0
  const prunedIndices: Array<number> = []

  // Walk newest → oldest, protecting recent tool outputs.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "tool") continue

    const msgBytes = estimateMessageBytes(msg)
    if (protectedBytes < PRUNE_PROTECT_BYTES) {
      protectedBytes += msgBytes
    } else {
      prunedBytes += msgBytes
      prunedIndices.push(i)
    }
  }

  if (prunedBytes < PRUNE_MINIMUM_BYTES) {
    return payload
  }

  const newMessages = [...messages]
  for (const idx of prunedIndices) {
    newMessages[idx] = { ...newMessages[idx], content: PRUNED_PLACEHOLDER }
  }

  consola.info(
    `Pruned ${prunedIndices.length} old tool outputs (~${prunedBytes} bytes reclaimed)`,
  )
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2: strip base64 images from older messages ───────────────

function stripOldImages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages
  const newMessages = [...messages]
  let strippedCount = 0
  let strippedBytes = 0

  // Keep images only in the last 4 messages (recent visual context).
  const protectFromEnd = 4
  const protectBoundary = Math.max(0, messages.length - protectFromEnd)

  for (let i = 0; i < protectBoundary; i++) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue

    const beforeStripped = strippedCount
    const newContent = msg.content.map((part) => {
      if ("type" in part && part.type === "image_url") {
        strippedCount++
        strippedBytes += part.image_url.url.length
        return { type: "text" as const, text: IMAGE_STRIPPED_PLACEHOLDER }
      }
      return part
    })

    if (strippedCount > beforeStripped) {
      newMessages[i] = { ...msg, content: newContent }
    }
  }

  if (strippedCount > 0) {
    consola.info(
      `Stripped ${strippedCount} base64 images (~${strippedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2b: strip ALL images regardless of recency ───────────────

function stripAllImages(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let strippedCount = 0
  let strippedBytes = 0
  const newMessages = payload.messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const before = strippedCount
    const newContent = msg.content.map((part) => {
      if ("type" in part && part.type === "image_url") {
        strippedCount++
        strippedBytes += part.image_url.url.length
        return { type: "text" as const, text: IMAGE_STRIPPED_PLACEHOLDER }
      }
      return part
    })
    return strippedCount > before ? { ...msg, content: newContent } : msg
  })
  if (strippedCount > 0) {
    consola.warn(
      `Stripped ${strippedCount} ALL images (~${strippedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 2c: truncate oversized tool outputs ──────────────────────

function truncateOversizedToolOutputs(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  let truncatedCount = 0
  let reclaimedBytes = 0
  const newMessages = payload.messages.map((msg) => {
    if (msg.role !== "tool") return msg
    if (typeof msg.content !== "string") return msg
    if (msg.content.length <= TOOL_OUTPUT_HARD_CAP) return msg
    const before = msg.content.length
    const truncated =
      msg.content.slice(0, TOOL_OUTPUT_HARD_CAP) + TOOL_TRUNCATED_SUFFIX
    truncatedCount++
    reclaimedBytes += before - truncated.length
    return { ...msg, content: truncated }
  })
  if (truncatedCount > 0) {
    consola.warn(
      `Truncated ${truncatedCount} oversized tool outputs (~${reclaimedBytes} bytes reclaimed)`,
    )
  }
  return { ...payload, messages: newMessages }
}

// ── Reduction step 3: drop oldest conversation messages ─────────────────────

function dropOldMessages(
  payload: ChatCompletionsPayload,
  ceiling: number,
): ChatCompletionsPayload {
  const systemMessages = payload.messages.filter(
    (m) => m.role === "system" || m.role === "developer",
  )
  const conversationMessages = payload.messages.filter(
    (m) => m.role !== "system" && m.role !== "developer",
  )

  // Compute reusable system byte total.
  let baseBytes = 200
  for (const m of systemMessages) baseBytes += estimateMessageBytes(m)
  if (payload.tools) {
    for (const tool of payload.tools) {
      baseBytes += JSON.stringify(tool).length + 20
    }
  }

  // Compute per-message byte sizes once for the conversation tail.
  const convBytes = conversationMessages.map((m) => estimateMessageBytes(m))
  let totalBytes = baseBytes + convBytes.reduce((a, b) => a + b, 0)

  let dropped = 0
  while (conversationMessages.length > 2 && totalBytes > ceiling) {
    const removedBytes = convBytes.shift() ?? 0
    conversationMessages.shift()
    totalBytes -= removedBytes
    dropped++
  }

  // Avoid stranding a tool_result whose corresponding tool_use was just
  // dropped. Copilot/Vertex rejects with "unexpected tool_use_id ... Each
  // tool_result block must have a corresponding tool_use block in the
  // previous message." Keep dropping from the front while the new head is
  // either a `tool` role message OR a user/assistant message whose content
  // begins with a tool_result/tool_use_id reference. Cheapest heuristic:
  // drop while head.role === "tool".
  let orphansDropped = 0
  while (
    conversationMessages.length > 2
    && conversationMessages[0].role === "tool"
  ) {
    const removedBytes = convBytes.shift() ?? 0
    conversationMessages.shift()
    totalBytes -= removedBytes
    orphansDropped++
  }

  if (dropped > 0 || orphansDropped > 0) {
    consola.warn(
      `Dropped ${dropped} oldest conversation messages + ${orphansDropped} orphaned tool results (~${totalBytes} bytes remaining, limit ${ceiling})`,
    )
  }

  if (totalBytes > ceiling) {
    consola.error(
      `Payload still over ${ceiling}B after all reductions (${totalBytes}B). Forwarding anyway — Copilot will likely return 413 → 400 prompt-too-long for reactive compaction.`,
    )
  }

  return {
    ...payload,
    messages: [...systemMessages, ...conversationMessages],
  }
}
