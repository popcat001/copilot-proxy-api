import type { Model } from "~/services/copilot/get-models"

export const DEFAULT_PROMPT_TOKENS = 200_000
export const ONE_M_PROMPT_TOKENS = 936_000
export const ONE_M_CONTEXT_TOKENS = 1_000_000

const MODEL_PROMPT_TOKEN_OVERRIDES: Record<string, number> = {
  "gpt-6.1-sol": ONE_M_PROMPT_TOKENS,
}

const MODEL_CONTEXT_TOKEN_OVERRIDES: Record<string, number> = {
  "gpt-6.1-sol": ONE_M_CONTEXT_TOKENS,
}

export function getModelPromptLimit(
  modelId: string,
  limits?: Model["capabilities"]["limits"],
): number {
  return getKnownModelPromptLimit(modelId, limits) ?? DEFAULT_PROMPT_TOKENS
}

export function getKnownModelPromptLimit(
  modelId: string,
  limits?: Model["capabilities"]["limits"],
): number | undefined {
  if (limits?.max_prompt_tokens) return limits.max_prompt_tokens
  if (limits?.max_context_window_tokens) return limits.max_context_window_tokens
  if (MODEL_PROMPT_TOKEN_OVERRIDES[modelId]) {
    return MODEL_PROMPT_TOKEN_OVERRIDES[modelId]
  }
  if (isOneMillionContextModel(modelId)) return ONE_M_PROMPT_TOKENS
  return undefined
}

export function getModelContextLimit(
  modelId: string,
  limits?: Model["capabilities"]["limits"],
): number {
  if (limits?.max_context_window_tokens) return limits.max_context_window_tokens
  if (MODEL_CONTEXT_TOKEN_OVERRIDES[modelId]) {
    return MODEL_CONTEXT_TOKEN_OVERRIDES[modelId]
  }
  if (isOneMillionContextModel(modelId)) return ONE_M_CONTEXT_TOKENS
  return DEFAULT_PROMPT_TOKENS
}

function isOneMillionContextModel(modelId: string): boolean {
  return /(?:^|[-_.])1m(?:$|[-_.])/i.test(modelId)
}
