import consola from "consola"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { HTTPError } from "./error"
import { getModelPromptLimit } from "./model-limits"
import { state } from "./state"

export function createPromptTooLongError(
  payload: ChatCompletionsPayload,
  bodyLength: number,
  payloadLimit?: number,
): HTTPError {
  const estimatedTokens = Math.ceil(bodyLength / 4)
  const modelCaps = state.models?.data.find((m) => m.id === payload.model)
    ?.capabilities.limits
  const modelLimit = getModelPromptLimit(payload.model, modelCaps)
  const maxOutputTokens =
    payload.max_completion_tokens ?? payload.max_tokens ?? 0

  const message =
    payloadLimit ?
      `prompt is too long: payload size ${bodyLength} bytes exceeds proxy limit of ${payloadLimit} bytes; compact the conversation and retry`
    : `prompt is too long: input length and \`max_tokens\` exceed context limit: ${estimatedTokens} + ${maxOutputTokens} > ${modelLimit} tokens`

  consola.warn(`${message} — returning 400 to request client compaction`)

  return new HTTPError(
    "Prompt too long",
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message,
        },
      }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      },
    ),
  )
}

export function enforcePayloadLimit(
  model: string,
  bytes: number,
  limit: number,
): void {
  if (bytes > limit) {
    throw createPromptTooLongError({ model, messages: [] }, bytes, limit)
  }
}
