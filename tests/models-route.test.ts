import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { modelRoutes } from "~/routes/models/route"

afterEach(() => {
  state.models = undefined
})

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  return app
}

function cacheTestModels(): void {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-5.5",
        object: "model",
        name: "GPT-5.5",
        model_picker_enabled: true,
        preview: false,
        vendor: "openai",
        version: "1",
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt-5.5",
          limits: {},
          object: "model_capabilities",
          supports: {
            parallel_tool_calls: true,
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
}

describe("models route", () => {
  test("preserves upstream 1M limits in the public catalog", async () => {
    cacheTestModels()
    const model = state.models?.data[0]
    if (!model) throw new Error("Expected model")
    model.id = "claude-opus-5.5"
    model.capabilities.limits = {
      max_context_window_tokens: 1_000_000,
      max_prompt_tokens: 936_000,
      max_output_tokens: 64_000,
    }
    const response = await createApp().request("/v1/models")
    const body = (await response.json()) as ModelsResponse
    expect(body.data[0].capabilities.limits).toEqual(model.capabilities.limits)
  })
  test("generates Codex limits and effort from the selected Copilot model", async () => {
    cacheTestModels()
    const model = state.models?.data[0]
    if (!model) throw new Error("Expected model")
    model.capabilities.limits = {
      max_context_window_tokens: 400000,
      max_prompt_tokens: 272000,
    }
    const response = await createApp().request(
      "/v1/models/gpt-5.5/codex-config",
    )
    const config = await response.text()
    expect(config).toContain("model_context_window = 400000")
    expect(config).toContain("model_auto_compact_token_limit = 244800")
    expect(config).toContain('model_reasoning_effort = "high"')
  })
  test("preserves Codex bundled metadata for catalog refreshes", async () => {
    cacheTestModels()

    const response = await createApp().request(
      "/v1/models?client_version=0.146.0",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: [] })
  })

  test("advertises Claude Code effort and thinking capabilities", async () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-opus-5",
          object: "model",
          name: "Claude Opus 5",
          model_picker_enabled: true,
          preview: false,
          vendor: "anthropic",
          version: "1",
          supported_endpoints: ["/chat/completions"],
          capabilities: {
            family: "claude-opus-5",
            limits: {},
            object: "model_capabilities",
            supports: {
              adaptive_thinking: true,
              reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
            },
            tokenizer: "cl100k_base",
            type: "chat",
          },
        },
      ],
    } satisfies ModelsResponse

    const response = await createApp().request("/v1/models")
    const body = (await response.json()) as {
      data: Array<{
        capabilities: unknown
        supported_capabilities: Array<string>
      }>
      has_more: boolean
      models?: unknown
      object: string
    }

    expect(response.status).toBe(200)
    expect(body.object).toBe("list")
    expect(body.has_more).toBe(false)
    expect(body.models).toBeUndefined()
    expect(body.data[0].capabilities).toEqual(state.models.data[0].capabilities)
    expect(body.data[0].supported_capabilities).toEqual([
      "effort",
      "xhigh_effort",
      "max_effort",
      "thinking",
      "adaptive_thinking",
      "interleaved_thinking",
    ])
  })
})
