import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResponseCache } from "../src/llm/cache.js";
import { OllamaBackend } from "../src/llm/ollama.js";
import { OpenAICompatibleBackend } from "../src/llm/openai-compatible.js";
import { ContextOverflowError, type ChatRequest } from "../src/llm/types.js";

/** A stub HTTP server that imitates the Ollama and OpenAI chat APIs. */
let server: Server;
let base = "";
const requests: { path: string; body: any }[] = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = req.method === "POST" ? JSON.parse(await readBody(req)) : null;
    requests.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "qwen3:4b", digest: "abc123def456", details: { family: "qwen3", parameter_size: "4.0B", quantization_level: "Q4_K_M" } }] }));
    } else if (req.url === "/api/chat" && body.model === "tiny-ctx") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "request (417 tokens) exceeds the available context size (256 tokens), try increasing it" }));
    } else if (req.url === "/api/chat") {
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: "<think>hmm</think>", tool_calls: [{ function: { name: "crm_get_customer", arguments: { customer_id: "C017" } } }] },
          done_reason: "stop",
          prompt_eval_count: 321,
          eval_count: 12,
        }),
      );
    } else if (req.url === "/v1/chat/completions") {
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "execute_code", arguments: '{"code":"console.log(1)"}' } }] },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const request: ChatRequest = {
  seed: 7,
  tools: [{ name: "crm_get_customer", description: "Get a customer", parameters: { type: "object", properties: { customer_id: { type: "string" } } } }],
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "crm_get_customer", arguments: { customer_id: "C001" } }] },
    { role: "tool", content: "{}", toolCallId: "c0", name: "crm_get_customer" },
  ],
};

describe("OllamaBackend", () => {
  it("sends num_ctx, seed and think, and normalises the response", async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), "llm-cache-")));
    const b = new OllamaBackend({ id: "q", provider: "ollama", model: "qwen3:4b", baseUrl: base, contextWindow: 16384, temperature: 0.7, think: false }, cache);
    const r = await b.chat(request);
    const sent = requests.filter((x) => x.path === "/api/chat").at(-1)!.body;
    expect(sent.options).toMatchObject({ num_ctx: 16384, seed: 7, temperature: 0.7 });
    expect(sent.think).toBe(false);
    expect(sent.truncate).toBe(false);
    expect(sent.shift).toBe(false);
    expect(sent.messages[3]).toMatchObject({ role: "tool", tool_name: "crm_get_customer" });
    expect(r.toolCalls[0]).toMatchObject({ name: "crm_get_customer", arguments: { customer_id: "C017" } });
    expect(r.content).toBe("");
    expect(r.usage).toEqual({ promptTokens: 321, completionTokens: 12 });

    const before = requests.length;
    const again = await b.chat(request);
    expect(again.cached).toBe(true);
    expect(requests.length).toBe(before);
  });

  it("reports context overflow instead of silently truncating", async () => {
    const b = new OllamaBackend({ id: "t", provider: "ollama", model: "tiny-ctx", baseUrl: base, contextWindow: 256 });
    await expect(b.chat(request)).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it("reports model digest and quantisation", async () => {
    const info = await new OllamaBackend({ id: "q", provider: "ollama", model: "qwen3:4b", baseUrl: base }).describe();
    expect(info).toMatchObject({ digest: "abc123def456", quantization: "Q4_K_M", parameterSize: "4.0B" });
  });

  it("fails clearly when a model is not pulled", async () => {
    await expect(new OllamaBackend({ id: "q", provider: "ollama", model: "llama9:1b", baseUrl: base }).describe()).rejects.toThrow(/ollama pull/);
  });
});

describe("OpenAICompatibleBackend", () => {
  it("parses tool calls and usage", async () => {
    const b = new OpenAICompatibleBackend({ id: "o", provider: "openai-compatible", model: "test-model", baseUrl: `${base}/v1`, temperature: 0 });
    const r = await b.chat(request);
    expect(r.toolCalls[0]).toMatchObject({ id: "call_1", name: "execute_code", arguments: { code: "console.log(1)" } });
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 7 });
    const sent = requests.filter((x) => x.path === "/v1/chat/completions").at(-1)!.body;
    expect(sent.seed).toBe(7);
    expect(sent.messages[2].tool_calls[0].function.arguments).toBe('{"customer_id":"C001"}');
  });
});
