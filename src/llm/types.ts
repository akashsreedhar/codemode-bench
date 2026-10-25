import type { JsonSchema } from "../mcp/pool.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Raw argument string as produced by the model, when the provider exposes it. */
  rawArguments?: string;
  /** Set when the model produced arguments that are not valid JSON. */
  argumentParseError?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  seed: number;
  /** Aborts the request (used to enforce the per-run time limit). */
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
  latencyMs: number;
  cached: boolean;
}

export interface ModelInfo {
  provider: string;
  model: string;
  baseUrl?: string;
  digest?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
}

export interface LLMBackend {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  describe(): Promise<ModelInfo>;
}

export type ProviderName = "ollama" | "openai-compatible" | "groq" | "gemini" | "openrouter" | "mock";

export interface ModelConfig {
  /** Short identifier used in results, e.g. "qwen3-4b". */
  id: string;
  provider: ProviderName;
  /** Provider model name, e.g. "qwen3:4b". */
  model: string;
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Context window in tokens. For Ollama this is sent as `num_ctx`. */
  contextWindow?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Ollama: enable or disable "thinking" for reasoning models. */
  think?: boolean;
  requestsPerMinute?: number;
  /** Extra provider-specific request fields (Ollama `options` or OpenAI body fields). */
  extra?: Record<string, unknown>;
}

export class ContextOverflowError extends Error {}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
