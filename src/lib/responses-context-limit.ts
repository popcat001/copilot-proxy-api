import { getKnownModelPromptLimit } from "./model-limits"
import { state } from "./state"

/**
 * Hard transport ceiling. Azure Front Door rejects bodies above ~5.4 MB before
 * Copilot ever sees them, so trimming to stay under this is not a guess about
 * token accounting — it is a verified wire limit. Enforced unconditionally.
 */
export const MAX_RESPONSES_PAYLOAD_BYTES = 5_000_000

/** Estimated serialized bytes per token, used only for opt-in trimming.
 * Keep separate from context-manager's legacy unescaped-content estimate.
 * Upstream token counts remain authoritative.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4.3
const TOKEN_RESERVE = 8_000
/**
 * Byte ceiling for the forwarded payload.
 *
 * By default this is the transport ceiling alone: the proxy forwards the
 * client's history verbatim and lets Copilot enforce its own token limits, so
 * a rejection is upstream's real answer rather than a local guess. Rewriting
 * history pre-emptively both discards context Copilot would have accepted and
 * breaks prompt-cache continuity, because `dropOldInputItems` rewrites from the
 * oldest item forward — exactly the stable prefix a cache is keyed on.
 *
 * With `responsesContextTrim` enabled, the smaller token-derived ceiling is
 * applied too, restoring the previous lossy behavior for anyone who wants it.
 */
export function computeResponsesPayloadCeiling(modelId: string): number {
  if (!state.responsesContextTrim) return MAX_RESPONSES_PAYLOAD_BYTES

  const limits = state.models?.data.find((m) => m.id === modelId)?.capabilities
    .limits
  const maxPromptTokens = getKnownModelPromptLimit(modelId, limits)
  if (!maxPromptTokens) return MAX_RESPONSES_PAYLOAD_BYTES

  const tokenDerivedBytes = Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
  return Math.min(MAX_RESPONSES_PAYLOAD_BYTES, tokenDerivedBytes)
}
