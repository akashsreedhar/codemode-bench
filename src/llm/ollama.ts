import { ResponseCache } from "./cache.js";
import { httpFetch } from "./http.js";
import { RateLimiter, withRetry } from "./ratelimit.js";
import {
  ContextOverflowError,
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMBackend,
  type ModelConfig,
  type ModelInfo,
  type ToolCall,
} from "./types.js";

/**
 * Backend for Ollama's native `/api/chat` endpoint. The native API (rather
 * than the OpenAI-compatible one) is used because it accepts `num_ctx`,
 * `seed` and `think`, which matter for reproducible small-model runs.
 */
export class OllamaBackend implements LLMBackend {
  readonly provider = "ollama";
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: ModelConfig,
    private readonly cache?: ResponseCache,
  ) {
    this.id = config.id;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    if (!/^https?:\/\//.test(this.baseUrl)) this.baseUrl = `http://${this.baseUrl}`;
    this.limiter = new RateLimiter(config.requestsPerMinute);
  }

  private toWire(messages: ChatMessage[]) {
    return messages.map((m) => {
      switch (m.role) {
        case "assistant":
          return {
            role: "assistant",
            content: m.content,
            ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) } : {}),
          };
        case "tool":
          return { role: "tool", content: m.content, tool_name: m.name };
        default:
          return { role: m.role, content: m.content };
      }
    });
  }

  private body(req: ChatRequest) {
    const c = this.config;
    return {
      model: c.model,
      messages: this.toWire(req.messages),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: false,
      // Fail loudly instead of silently dropping history when the context window is full.
      truncate: false,
      shift: false,
      ...(c.think !== undefined ? { think: c.think } : {}),
      options: {
        seed: req.seed,
        ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
        ...(c.topP !== undefined ? { top_p: c.topP } : {}),
        ...(c.contextWindow !== undefined ? { num_ctx: c.contextWindow } : {}),
        ...(c.maxTokens !== undefined ? { num_predict: c.maxTokens } : {}),
        ...(c.extra ?? {}),
      },
      keep_alive: "30m",
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.body(req);
    const key = ResponseCache.key({ provider: this.provider, baseUrl: this.baseUrl, body });
    const hit = await this.cache?.get(key);
    if (hit) return hit;

    await this.limiter.acquire();
    const started = Date.now();
    const json = await withRetry(async () => {
      const res = await httpFetch(`${this.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: req.signal });
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && /context|too long|exceeds/i.test(text)) throw new ContextOverflowError(text);
        throw new ProviderError(`Ollama ${res.status}: ${text.slice(0, 500)}`, res.status);
      }
      return JSON.parse(text) as OllamaChatResponse;
    });
    const latencyMs = Date.now() - started;

    const msg = json.message ?? { role: "assistant", content: "" };
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => {
      const raw = tc.function?.arguments;
      let args: unknown = raw;
      let parseError: string | undefined;
      if (typeof raw === "string") {
        try {
          args = JSON.parse(raw);
        } catch (e) {
          parseError = (e as Error).message;
          args = {};
        }
      }
      return {
        id: `call_${req.messages.length}_${i}`,
        name: tc.function?.name ?? "",
        arguments: args ?? {},
        ...(typeof raw === "string" ? { rawArguments: raw } : {}),
        ...(parseError ? { argumentParseError: parseError } : {}),
      };
    });
    const response: ChatResponse = {
      content: stripThinking(msg.content ?? ""),
      toolCalls,
      usage: { promptTokens: json.prompt_eval_count ?? 0, completionTokens: json.eval_count ?? 0 },
      finishReason: json.done_reason ?? "stop",
      latencyMs,
      cached: false,
    };
    await this.cache?.set(key, response);
    return response;
  }

  async describe(): Promise<ModelInfo> {
    let tags: { models?: { name: string; model?: string; digest?: string; details?: OllamaDetails }[] };
    try {
      const res = await httpFetch(`${this.baseUrl}/api/tags`);
      tags = (await res.json()) as typeof tags;
    } catch (err) {
      throw new ProviderError(`Cannot reach Ollama at ${this.baseUrl}. Is it installed and running ('ollama serve')? (${(err as Error).message})`);
    }
    const wanted = this.model.includes(":") ? this.model : `${this.model}:latest`;
    const entry = tags.models?.find((m) => m.name === wanted || m.model === wanted);
    if (!entry) throw new ProviderError(`Model '${this.model}' is not available in Ollama. Run: ollama pull ${this.model}`);
    return {
      provider: this.provider,
      model: this.model,
      baseUrl: this.baseUrl,
      digest: entry.digest,
      family: entry.details?.family,
      parameterSize: entry.details?.parameter_size,
      quantization: entry.details?.quantization_level,
    };
  }
}

interface OllamaDetails {
  family?: string;
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaChatResponse {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Remove reasoning blocks some models emit inline even when thinking is disabled. */
export function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
