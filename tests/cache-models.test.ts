import { afterEach, describe, expect, mock, test } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  state.models = undefined
})

function model(id: string): Model {
  return {
    id,
    object: "model",
    name: id,
    model_picker_enabled: true,
    preview: false,
    vendor: "Anthropic",
    version: id,
    capabilities: {
      family: id,
      limits: {
        max_context_window_tokens: 1_000_000,
        max_output_tokens: 64_000,
        max_prompt_tokens: 936_000,
      },
      object: "model_capabilities",
      supports: {
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

describe("cacheModels", () => {
  test("uses the proposed API version only for model discovery", async () => {
    const fetchMock = mock((_url: string, _options?: RequestInit) =>
      Response.json({ object: "list", data: [model("claude-opus-5.5")] }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await cacheModels()
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get("x-github-api-version")).toBe("2026-08-01")
    expect(copilotHeaders(state)["x-github-api-version"]).toBe("2025-04-01")
    expect(state.models?.data[0].capabilities.limits).toEqual({
      max_context_window_tokens: 1_000_000,
      max_prompt_tokens: 936_000,
      max_output_tokens: 64_000,
    })
  })
  test("does not advertise Opus 5 when Copilot omits it", async () => {
    const upstreamModels = {
      object: "list",
      data: [model("claude-opus-4.8")],
    } satisfies ModelsResponse

    globalThis.fetch = mock(() =>
      Response.json(upstreamModels),
    ) as unknown as typeof fetch

    await cacheModels()

    expect(state.models).toEqual(upstreamModels)
    expect(state.models?.data.some((item) => item.id === "claude-opus-5")).toBe(
      false,
    )
  })

  test("keeps native upstream Opus 5 metadata unchanged", async () => {
    const nativeOpus5 = model("claude-opus-5")
    nativeOpus5.name = "Native Claude Opus 5"
    nativeOpus5.supported_endpoints = ["/responses"]
    nativeOpus5.capabilities.limits.max_output_tokens = 128_000
    nativeOpus5.capabilities.supports.reasoning_effort = ["high"]
    const upstreamModels = {
      object: "list",
      data: [nativeOpus5],
    } satisfies ModelsResponse

    globalThis.fetch = mock(() =>
      Response.json(upstreamModels),
    ) as unknown as typeof fetch

    await cacheModels()

    const cachedOpus5 = state.models?.data.find(
      (item) => item.id === "claude-opus-5",
    )
    expect(cachedOpus5?.name).toBe("Native Claude Opus 5")
    expect(cachedOpus5?.supported_endpoints).toEqual(["/responses"])
    expect(cachedOpus5?.capabilities.limits.max_output_tokens).toBe(128_000)
    expect(cachedOpus5?.capabilities.supports.reasoning_effort).toEqual([
      "high",
    ])
    expect(state.models).toEqual(upstreamModels)
  })
})
