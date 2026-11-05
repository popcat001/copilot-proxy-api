# How copilot-proxy-api works with Claude Code

Nov 5, 2026

## Key takeaways

- The proxy stands in for the Anthropic API. Claude Code is launched with `ANTHROPIC_BASE_URL=http://localhost:4141`, so its model calls go to the proxy instead of `api.anthropic.com`.
- Claude Code's own harness does all the agent work: system prompt, tools, the agent loop, permissions, hooks, compaction. The proxy runs no agent and executes no tools.
- For each model call, the proxy converts the Anthropic request to Copilot's OpenAI-style format, sends it under your Copilot subscription, and converts the reply back.
- "First-class Claude Code support" means close compatibility with the Anthropic API plus a setup helper. It does not mean the proxy has a harness of its own.

## Who runs what

Claude Code does all of the agent work, Copilot produces each model reply, and the proxy translates between the two.

```
┌──────────────────────────────┐      ┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Claude Code                  │      │ copilot-proxy-api            │      │ GitHub Copilot API           │
│ The harness, on your machine │      │ localhost:4141               │      │ api.githubcopilot.com        │
│                              │ ───► │                              │ ───► │                              │
│ Agent loop, system prompt    │      │ Anthropic to OpenAI format   │      │ Hosts the model you picked   │
│ Tools: Bash, Edit, Read, MCP │ ◄─── │ Adds Copilot token, headers  │ ◄─── │ Chat Completions or          │
│ Runs every tool locally      │      │ OpenAI to Anthropic SSE      │      │ Responses endpoint           │
│ Permissions, hooks, memory   │      │ 15 s pings, error cleanup    │      │ Returns text or a tool call  │
│ Compaction, subagents        │      │ No agent state, no tools     │      │ Uses your subscription       │
└──────────────────────────────┘      └──────────────────────────────┘      └──────────────────────────────┘
                          Anthropic Messages API              OpenAI Chat or Responses API
```

Requests travel right along the top arrows, and streamed replies return along the bottom ones. When a reply contains a tool call, Claude Code runs it; the proxy and Copilot never execute tools.

## Setup: two processes and one env var

The proxy and Claude Code are separate processes, and you start both. The proxy never launches Claude Code.

```
Terminal 1: copilot-proxy-api start --claude-code    # server on :4141
Terminal 2: ANTHROPIC_BASE_URL=http://localhost:4141 claude
```

`--claude-code` asks you to pick a main model and a small model from Copilot's list. It then copies a launch command to your clipboard (`src/start.ts:86-127`). That command sets these variables:

| Variable | Value | Purpose |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://localhost:4141` | Sends Claude Code's API calls to the proxy instead of `api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | `dummy` | Claude Code requires a value; the proxy ignores it and uses the Copilot token |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` | main model | Model for normal turns |
| `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` | small model | Model for background tasks |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Turn off telemetry and extra model calls |

Variables set inline apply only to that one `claude` process. To make them permanent for a project, put them in the `env` block of `.claude/settings.json`. The README has an example under Manual Configuration. Start the proxy first; if it isn't running, Claude Code's requests fail with connection errors.

## Request lifecycle: one turn

Each model call passes through the proxy once, and the proxy keeps no agent state between turns.

1. **Claude Code sends a request.** It posts a normal Anthropic Messages request (system prompt, conversation so far, tool schemas) to `localhost:4141/v1/messages`.
2. **The proxy picks an upstream endpoint.** `handleCompletion` (`src/routes/messages/handler.ts:82`) checks the model's `supported_endpoints`.
   - Chat-capable models: `non-stream-translation.ts` converts the request to OpenAI Chat Completions format. System prompt, `tool_use`/`tool_result` blocks, images, and PDF text are carried over. `cache_control` markers and earlier thinking blocks are dropped.
   - Models that only support `/responses`: `responses-bridge.ts` converts the request to the OpenAI Responses format and keeps the `output_config.effort` setting.
3. **The proxy calls Copilot.** It sends the request to `api.githubcopilot.com` with the current Copilot token and VS Code client headers (`copilot-integration-id: vscode-chat`, `editor-version`; see `src/lib/api-config.ts:24`).
4. **The proxy translates the reply back.** `stream-translation.ts` turns OpenAI stream chunks into Anthropic SSE events (`message_start`, `content_block_delta`, `message_stop`). It maps stop reasons and returns the model name Claude Code asked for.
5. **Claude Code continues the loop.** If the reply contains a tool call, Claude Code runs the tool locally, adds the `tool_result`, and sends the next request.

Authentication happens once, at startup (`src/services/github/`). A GitHub device-code login produces a GitHub token. The proxy exchanges it for a short-lived Copilot token through `copilot_internal/v2/token` and refreshes that token automatically.

## Claude Code compatibility work

Most of the "first-class support" lies in handling Claude Code's specific behaviors, not just converting formats.

| Claude Code behavior | What the proxy does |
| --- | --- |
| Ends a stream after 90 s of silence | Sends `event: ping` every 15 s (`handler.ts:48`) |
| Large Opus replies can take 10–60 s; Bun's 10 s idle timeout closed the socket | Turns off Bun's idle timeout (`start.ts:140`) |
| Tracks open content blocks by index and throws `Content block not found` | Closes open blocks (`content_block_stop`, `message_stop`) before sending an error event |
| Starts compaction when it receives `prompt is too long` | Maps upstream 413 errors and backend timeouts to HTTP 400 `prompt is too long` |
| Calls `/v1/messages/count_tokens` | Counts input tokens with a local tokenizer |
| Shows special UI for refusals | Maps `content_filter` to the `refusal` stop reason |
| Shows the model name it asked for | Returns the requested model, not Copilot's internal ID |
| Expects Anthropic error types | Uses Anthropic error envelopes (`invalid_request_error`, `rate_limit_error`, `overloaded_error`, …) |

## Limitations and caveats

The proxy doesn't fake Anthropic features that Copilot lacks, so some Claude Code features are missing or reduced.

- **No thinking blocks in replies.** Copilot doesn't expose extended thinking, and thinking blocks in earlier turns are dropped from requests.
- **Prompt caching is automatic, not client-controlled.** Copilot caches prompt prefixes on its own, and the proxy reports those hits to Claude Code as `cache_read_input_tokens`. Claude Code's `cache_control` markers are ignored, and `cache_creation_input_tokens` is never set. Measured on Nov 5, 2026 with claude-sonnet-5, each step of a growing agent loop read 71–82% of its input from cache: everything except the newly added content, which is the maximum possible. The ignored markers cost nothing.
- **No Anthropic-hosted tools.** Web search, code execution, and computer use aren't available. Claude Code's local tools are unaffected because Claude Code runs them itself.
- **Image-only PDFs lose their content.** Only extracted text is sent, and only for PDFs up to 3 MB.
- **The model may not be Claude.** Claude Code's prompts and tool formats are tuned for Claude models. A GPT model picked from Copilot's list may follow them less reliably.
- **Unofficial access.** Requests are presented as VS Code Copilot Chat traffic. GitHub may change or block this, and heavy automation can lead to Copilot access being restricted.

## Code map

| File | Role |
| --- | --- |
| `src/start.ts` | CLI `start` command, `--claude-code` env-var generator, Bun server setup |
| `src/services/github/` | Device-code login and the GitHub-to-Copilot token exchange |
| `src/lib/api-config.ts` | Copilot base URL and VS Code client headers |
| `src/routes/messages/handler.ts` | `/v1/messages` entry point, endpoint routing, ping keepalive, error cleanup |
| `src/routes/messages/non-stream-translation.ts` | Anthropic request to and from OpenAI Chat Completions |
| `src/routes/messages/stream-translation.ts` | OpenAI stream chunks to Anthropic SSE events |
| `src/routes/messages/responses-bridge.ts` | Anthropic to and from the OpenAI Responses API, for Responses-only models |
| `src/routes/messages/count-tokens-handler.ts` | `/v1/messages/count_tokens` |
| `src/lib/prompt-too-long.ts` | Builds the `prompt is too long` error that starts compaction |
| `src/services/copilot/` | Upstream calls: chat completions, responses, models, embeddings |
