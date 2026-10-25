# Methodology

This document describes exactly what a benchmark run does, so that results can be interpreted and reproduced.

## 1. The simulated organisation

`src/world/generate.ts` builds a world from a seed (default `1337`) with a deterministic PRNG (mulberry32). The current time is fixed at `2026-03-15T09:00:00Z`, so tasks like "overdue" or "next meeting" have stable answers.

| Entity | Count | Notes |
|---|---|---|
| Customers | 120 | tier (free/pro/enterprise), country, account manager, contact details, address |
| Invoices | 424 | status (paid/open/overdue), line items, issue/due dates |
| Tickets | 400 | ~1 KB body each, priority, status, assignee (some unassigned), tags, comments |
| Calendar events | 43 | customer meetings and internal stand-ups over three weeks |
| Files | 10 | CSV exports, policy documents, reports |
| Staff | 9 | account managers, support agents, a support lead |

Each run works on a deep copy of the world. Changes made through tools are visible only to that run.

## 2. MCP servers and tools

Four MCP servers are implemented with the official TypeScript SDK and connected over an in-memory transport:

- **crm**: `crm_search_customers`, `crm_get_customer`, `crm_update_customer`, `crm_list_invoices`, `crm_update_invoice`
- **tickets**: `tickets_search`, `tickets_get`, `tickets_create`, `tickets_update`, `tickets_add_comment`
- **files**: `files_list`, `files_read`, `files_write`, `files_search`
- **comms**: `calendar_list_events`, `calendar_create_event`, `email_send`, `directory_list_staff`

All 18 core tools declare JSON Schema `inputSchema` and `outputSchema` and validate their inputs. List endpoints are paginated (`limit`, `offset`, `total`) with realistic defaults, and return full records. For example, `tickets_search` returns ticket bodies and comments. That is how many production APIs behave, and it is what makes intermediate data large.

**Distractor tools.** For the tool-count variable, `src/servers/distractors.ts` provides up to 144 extra tools across six plausible domains (HR, inventory, marketing, DevOps, finance, analytics). They work and return deterministic data, but no task needs them. They are added in a fixed, domain-balanced order.

**Exposure rule.** For a target tool count *N*, the task's required tools are always exposed. Remaining slots are filled first with other core tools, then with distractors (`planExposure`). Below 18, a run therefore sees only a subset of core tools. The recorded `exposedTools` can exceed *N* only when a task needs more tools than *N*.

## 3. Conditions

All conditions share the base system prompt in `src/conditions/types.ts`, the same user prompt, the turn budget and the result-size cap. Each condition adds only what it needs to explain its interaction style.

- **A · Direct.** Every exposed MCP tool is offered as a native function (name, description, input JSON Schema). Results are returned verbatim as JSON text.
- **B · Tool search.** Only `search_tools` (keyword relevance over names and descriptions) and `load_tools` are offered at first. Loaded tools become native functions on later turns. Calling an unloaded tool returns an error.
- **C · Code Mode.** The system prompt contains TypeScript declarations generated from the exposed tools' schemas (`src/codemode/codegen.ts`): an input interface, an output interface (from `outputSchema`, else `unknown`) and a documented method on `declare const codemode`. The only tool is `execute_code`.
- **D · Code Mode + discovery.** No declarations up front. `list_apis` returns one-line summaries per namespace (MCP server), `read_api` returns the declarations for one namespace, and `execute_code` runs code.

### The Code Mode sandbox

`src/codemode/sandbox.ts`:

1. Strips Markdown fences and wraps the code in an async function, so top-level `await` and `return` work.
2. Transpiles TypeScript to JavaScript with esbuild. Syntax errors are reported with line numbers.
3. Evaluates the code in a fresh QuickJS runtime (WebAssembly) with a 64 MB memory limit, a 30 s deadline enforced by an interrupt handler, and at most 300 host calls.
4. Provides only `console` and `codemode`. Each `codemode.<tool>(input)` call goes to the host, which calls the MCP tool and resolves the guest promise with the parsed result. A tool error is raised as a catchable `ToolError`. Accessing a non-existent method throws a `TypeError` that is classified as a *hallucinated API*.
5. Returns the console output, then the return value or error, to the model, capped at the same 100k characters as direct-mode results.

## 4. The agent loop

`src/agent/episode.ts` runs at most `maxTurns` model calls (20 in the pilot), within a wall-clock limit of `maxRunSeconds` (900 by default). For Ollama, requests are sent with `truncate: false` and `shift: false`, so a conversation that outgrows the context window fails visibly (`context_overflow`) instead of silently losing history. On each turn:

1. The current messages and tool definitions are sent to the model with the run's seed.
2. If the reply has tool calls, each is executed and its result appended. Several calls in one reply are executed in order.
3. If the reply has no tool calls and lenient parsing is on, the condition tries to recover a call from the text. Direct and tool-search conditions accept JSON or `<tool_call>` blocks; the Code Mode conditions accept a fenced code block that uses `codemode` or `console.log`. Recoveries are counted.
4. Otherwise the reply is the final answer and the loop ends.

The final world state and answer are then verified.

## 5. Verification

Each task in `src/tasks/suite.ts` derives its parameters and expected values from the initial world, then verifies:

- **Answers.** Numbers within a stated tolerance (IDs and dates are ignored when extracting numbers). Exact ID sets (Jaccard partial credit is recorded but does not count as success). Closed-vocabulary mentions. `key=value` formats where the prompt asks for them. Ties are handled explicitly: any tied value is accepted, but hedged answers that name several candidates fail.
- **State.** Records created, updated or sent (tickets, events, emails, files) are compared with the expected set. Collateral changes to records the task did not mention cause failure.

Two checks guard against verifier defects, and both run in CI:

- **Solvability.** A reference solution for every task runs through the full harness under all four conditions and must pass. The direct-mode replay issues independent calls as parallel tool calls, as capable models do.
- **No free passes.** A model that does nothing and answers "I have completed the task" must fail every task.

## 6. Metrics

| Metric | Definition |
|---|---|
| `outcome` | `success`, `failure`, or `error` (infrastructure/provider error, excluded from rates) |
| `failureMode` | `wrong_result`, `no_answer`, `turn_limit`, `context_overflow` (the request did not fit the context window), `time_limit` (the run exceeded `maxRunSeconds`) |
| `promptTokens`, `completionTokens` | Sum over turns, as reported by the provider |
| `promptChars` | Exact sum over turns of request characters (messages, tool calls and tool definitions) |
| `turns`, `toolCallsEmitted`, `mcpCalls`, `distractorCalls` | Interaction counts; `mcpCalls` includes calls made from inside the sandbox |
| `errorCounts` | Per-call error kinds (see `CallErrorKind`) |
| `contextSaturated` | The request likely filled the configured context window (estimate > 95% or provider count ≥ 98%) |
| `piiExposed` | Distinct customer emails and phone numbers found in any non-system message |
| `wallMs`, `llmLatencyMs` | End-to-end and model-only time |

## 7. Statistics

- **Success rates:** Wilson score 95% intervals.
- **Paired comparisons:** for each model and tool count, runs of a treatment condition are matched to direct-calling runs on (task, seed). The exact two-sided McNemar test is applied to the discordant pairs.
- **Aggregation:** the report de-duplicates by `runId` (the latest row wins) and uses one task-set fingerprint (the most common by default). It never includes `provider: mock` rows unless explicitly asked to for pipeline testing.

## 8. Reproducibility

- **Run identity.** `runId = sha256(experiment, task, condition, model id, model name, tool count, seed, world seed, task-set fingerprint)`. Re-running a config skips completed runs and retries runs that hit infrastructure errors.
- **Task-set fingerprint.** A hash of every task's ID, rendered prompt, parameters, required tools and reference solution.
- **Response cache.** Model responses are cached by a hash of the full request, in `.cache/llm`, so interrupted experiments resume without repeating model calls.
- **Provenance.** Every row stores the harness version, git commit and dirty flag, model digest, quantisation, parameter size, sampling settings and hardware (CPU, RAM, GPUs).
- **Traces.** Full message histories are saved as gzipped JSON per run under `results/<experiment>/traces/`.
