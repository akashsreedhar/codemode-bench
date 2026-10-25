import OpenAI from "openai";
import { ResponseCache } from "./cache.js";
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
import { stripThinking } from "./ollama.js";

/** Well-known OpenAI-compatible endpoints with free tiers. */
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; apiKeyEnv: string; requestsPerMinute?: number }> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", requestsPerMinute: 25 },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKeyEnv: "GEMINI_API_KEY", requestsPerMinute: 10 },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", requestsPerMinute: 15 },
};

/**
 * Backend for any OpenAI Chat Completions compatible endpoint: Groq, Gemini,
 * OpenRouter, vLLM, LM Studio, llama.cpp server, etc.
 */
export class OpenAICompatibleBackend implements LLMBackend {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  private readonly client: OpenAI;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: ModelConfig,
    private readonly cache?: ResponseCache,
  ) {
    const preset = PROVIDER_PRESETS[config.provider];
    this.id = config.id;
    this.model = config.model;
    this.provider = config.provider;
    this.baseUrl = config.baseUrl ?? preset?.baseUrl ?? "";
    if (!this.baseUrl) throw new Error(`Model '${config.id}': provider 'openai-compatible' requires baseUrl`);
    const keyEnv = config.apiKeyEnv ?? preset?.apiKeyEnv;
    const apiKey = keyEnv ? process.env[keyEnv] : "not-needed";
    if (keyEnv && !apiKey) throw new Error(`Model '${config.id}': environment variable ${keyEnv} is not set`);
    this.client = new OpenAI({ baseURL: this.baseUrl, apiKey: apiKey ?? "not-needed", maxRetries: 0, timeout: 600_000 });
    this.limiter = new RateLimiter(config.requestsPerMinute ?? preset?.requestsPerMinute);
  }

  private toWire(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
      switch (m.role) {
        case "assistant":
          return {
            role: "assistant",
            content: m.content || null,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function" as const,
                    function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.arguments ?? {}) },
                  })),
                }
              : {}),
          };
        case "tool":
          return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        default:
          return { role: m.role, content: m.content };
      }
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const c = this.config;
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: c.model,
      messages: this.toWire(req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      seed: req.seed,
      ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
      ...(c.topP !== undefined ? { top_p: c.topP } : {}),
      ...(c.maxTokens !== undefined ? { max_tokens: c.maxTokens } : {}),
      ...((c.extra ?? {}) as object),
    };
    const key = ResponseCache.key({ provider: this.provider, baseUrl: this.baseUrl, body });
    const hit = await this.cache?.get(key);
    if (hit) return hit;

    await this.limiter.acquire();
    const started = Date.now();
    const completion = await withRetry(async () => {
      try {
        return await this.client.chat.completions.create(body, { signal: req.signal });
      } catch (err) {
        if (err instanceof OpenAI.APIError) {
          const msg = `${this.provider} ${err.status ?? ""}: ${err.message}`;
          if (err.status === 400 && /context|too long|maximum.*tokens|reduce the length/i.test(err.message)) throw new ContextOverflowError(msg);
          const retryAfter = Number(err.headers?.get?.("retry-after"));
          throw new ProviderError(msg, err.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
        }
        throw err;
      }
    });
    const latencyMs = Date.now() - started;

    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== "function") return [];
      const raw = tc.function.arguments ?? "";
      try {
        return [{ id: tc.id, name: tc.function.name, arguments: raw ? JSON.parse(raw) : {}, rawArguments: raw }];
      } catch (e) {
        return [{ id: tc.id, name: tc.function.name, arguments: {}, rawArguments: raw, argumentParseError: (e as Error).message }];
      }
    });
    const response: ChatResponse = {
      content: stripThinking(message?.content ?? ""),
      toolCalls,
      usage: { promptTokens: completion.usage?.prompt_tokens ?? 0, completionTokens: completion.usage?.completion_tokens ?? 0 },
      finishReason: choice?.finish_reason ?? "stop",
      latencyMs,
      cached: false,
    };
    await this.cache?.set(key, response);
    return response;
  }

  async describe(): Promise<ModelInfo> {
    return { provider: this.provider, model: this.model, baseUrl: this.baseUrl };
  }
}
