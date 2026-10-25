# Adding a model or provider

Models are declared in an experiment config (`configs/*.yaml`). Each model needs a unique `id`, a `provider` and a provider `model` name.

## Ollama (local, free)

```yaml
models:
  - id: llama3.2-3b
    provider: ollama
    model: llama3.2:3b
    contextWindow: 16384   # sent as num_ctx
    temperature: 0.7
    maxTokens: 4096        # sent as num_predict
```

- The model must support tool calling in Ollama (see the "tools" tag on ollama.com).
- `think: false` disables reasoning traces for hybrid reasoning models such as Qwen3. Remove it for models that do not support the flag.
- Set `OLLAMA_HOST` or `baseUrl` to use a remote Ollama server.
- Before running, the harness checks that the model is pulled and records its digest, parameter size and quantisation.

## OpenAI-compatible endpoints

```yaml
models:
  # Free API tiers (keys from .env / environment)
  - { id: groq-gpt-oss-20b, provider: groq, model: "openai/gpt-oss-20b", temperature: 0.7, requestsPerMinute: 20 }
  - { id: gemini-flash, provider: gemini, model: "gemini-2.5-flash", temperature: 0.7, requestsPerMinute: 8 }
  - { id: openrouter-model, provider: openrouter, model: "vendor/model-name", temperature: 0.7 }

  # Self-hosted servers (vLLM, LM Studio, llama.cpp server, …)
  - { id: local-vllm, provider: openai-compatible, baseUrl: "http://localhost:8000/v1", model: "Qwen/Qwen3-8B", temperature: 0.7 }
```

| Provider | Base URL | API key variable |
|---|---|---|
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai-compatible` | `baseUrl` (required) | `apiKeyEnv` (optional) |

`requestsPerMinute` throttles requests on the client. Transient errors (429, 5xx) are retried with exponential backoff, honouring `Retry-After`. Use `extra` to pass provider-specific request fields.

Free tiers have per-minute and per-day token limits. Direct mode with many tools sends large requests on every turn, so keep tool counts low (see `configs/cloud-free.yaml`), or expect throttling.

## Adding a new provider type

Implement `LLMBackend` (`src/llm/types.ts`):

```ts
interface LLMBackend {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  describe(): Promise<ModelInfo>;
}
```

Register it in `createBackend` (`src/llm/index.ts`) and add the provider name to `ProviderName` and the config schema. `tests/llm.test.ts` shows how to test a backend against a local stub server.
