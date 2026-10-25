import { ResponseCache } from "./cache.js";
import { OllamaBackend } from "./ollama.js";
import { OpenAICompatibleBackend } from "./openai-compatible.js";
import type { LLMBackend, ModelConfig } from "./types.js";

export * from "./types.js";

/** Create a backend for a real provider. Mock backends are created per run by the oracle. */
export function createBackend(config: ModelConfig, cache?: ResponseCache): LLMBackend {
  switch (config.provider) {
    case "ollama":
      return new OllamaBackend(config, cache);
    case "openai-compatible":
    case "groq":
    case "gemini":
    case "openrouter":
      return new OpenAICompatibleBackend(config, cache);
    case "mock":
      throw new Error("Mock backends are created by the benchmark runner, not createBackend()");
  }
}

export { ResponseCache };
