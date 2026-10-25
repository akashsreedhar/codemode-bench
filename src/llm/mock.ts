import type { ChatRequest, ChatResponse, LLMBackend, ModelInfo, ToolCall } from "./types.js";

export interface ScriptedTurn {
  content?: string;
  toolCalls?: Omit<ToolCall, "id">[];
}

/** Decides the next assistant turn from the conversation so far. */
export type ScriptPolicy = (request: ChatRequest) => Promise<ScriptedTurn> | ScriptedTurn;

/**
 * A deterministic, offline backend driven by a script. It is used to test the
 * harness end to end (and to prove every task is solvable) without calling a
 * model. Results from this backend are never included in published reports.
 */
export class ScriptedBackend implements LLMBackend {
  readonly provider = "mock";

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly policy: ScriptPolicy,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const turn = await this.policy(req);
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(req.tools).length;
    const toolCalls = (turn.toolCalls ?? []).map((c, i) => ({ ...c, id: `mock_${req.messages.length}_${i}` }));
    return {
      content: turn.content ?? "",
      toolCalls,
      usage: { promptTokens: Math.ceil(promptChars / 4), completionTokens: Math.ceil(((turn.content ?? "").length + JSON.stringify(toolCalls).length) / 4) },
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      latencyMs: Date.now() - started,
      cached: false,
    };
  }

  async describe(): Promise<ModelInfo> {
    return { provider: this.provider, model: this.model };
  }
}
