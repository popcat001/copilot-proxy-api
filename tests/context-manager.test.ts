import { afterEach, describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  fitContext,
  MAX_PAYLOAD_BYTES,
  fitUnknownModelContext,
  UNKNOWN_MODEL_PAYLOAD_BYTES,
} from "~/lib/context-manager"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { type ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

afterEach(() => {
  state.chatContextTrim = false
})

const model = {
  id: "claude-opus-5.5",
  capabilities: { limits: { max_prompt_tokens: 200_000 } },
} as Model

describe("context manager", () => {
  test("preserves history above the old 672000-byte heuristic", () => {
    const payload: ChatCompletionsPayload = {
      model: model.id,
      messages: [{ role: "user", content: "x".repeat(900_000) }],
    }
    expect(fitContext(payload, model)).toBe(payload)
  })

  test("rejects oversized UTF-8 payloads without removing history", async () => {
    const payload: ChatCompletionsPayload = {
      model: model.id,
      messages: [{ role: "user", content: "界".repeat(1_700_000) }],
    }
    expect(JSON.stringify(payload).length).toBeLessThan(MAX_PAYLOAD_BYTES)
    let caught: unknown
    try {
      fitContext(payload, model)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HTTPError)
    if (!(caught instanceof HTTPError)) throw new Error("Expected HTTPError")
    expect(caught.response.status).toBe(400)
    expect(await caught.response.text()).toContain("prompt is too long")
    expect(payload.messages).toHaveLength(1)
  })

  test("requests compaction for oversized unknown aliases by default", () => {
    expect(() =>
      fitUnknownModelContext({
        model: "custom",
        messages: [{ role: "user", content: "x".repeat(2_000_000) }],
      }),
    ).toThrow(HTTPError)
  })
  test("conservatively fits unknown custom model aliases with opt-in trimming", () => {
    state.chatContextTrim = true
    const payload: ChatCompletionsPayload = {
      model: "ultracode",
      max_tokens: 100,
      messages: [
        { role: "user", content: "old-1\n" + "x".repeat(900_000) },
        { role: "assistant", content: "old-2\n" + "x".repeat(900_000) },
        { role: "user", content: "old-3\n" + "x".repeat(900_000) },
        { role: "assistant", content: "old-4\n" + "x".repeat(900_000) },
        { role: "user", content: "latest task" },
      ],
    }

    const fitted = fitUnknownModelContext(payload)

    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(
      UNKNOWN_MODEL_PAYLOAD_BYTES,
    )
    expect(fitted.messages.at(-1)?.content).toBe("latest task")
    expect(fitted.messages.length).toBeLessThan(payload.messages.length)
  })
})
