# Results

Each experiment writes to `results/<experiment>/`:

| File | Contents |
|---|---|
| `runs.jsonl` | One JSON object per run (schema below). Append-only; a re-run of the same `runId` supersedes earlier rows. |
| `manifest.json` | The experiment config, task-set fingerprint, harness version, git commit, hardware and model metadata of the latest session. |
| `traces/<runId>.json.gz` | The full message history and per-turn token/latency log of each run. |

`results/ci/` (scripted reference-solution runs used to test the harness) is not committed and is never included in reports.

## Run record (schema version 1)

| Field | Description |
|---|---|
| `runId` | Stable hash of experiment, task, condition, model, tool count, seed, world seed and task-set fingerprint |
| `taskId`, `category`, `chain`, `payload` | Task identity and tags |
| `condition` | `direct`, `toolsearch`, `codemode` or `codemode_discovery` |
| `modelId`, `provider`, `model`, `modelInfo` | Model identity, including digest, parameter size and quantisation when the provider reports them |
| `toolCount`, `exposedTools` | Requested and actual number of tools visible to the model |
| `seed`, `worldSeed` | Sampling seed and dataset seed |
| `outcome` | `success`, `failure`, or `error` (infrastructure error; excluded from statistics) |
| `failureMode` | `wrong_result`, `no_answer`, `turn_limit` or `context_overflow` (null on success) |
| `score`, `verification` | Partial credit in [0, 1] and the verifier's explanation |
| `answer` | Final answer text (first 2,000 characters) |
| `turns`, `toolCallsEmitted`, `mcpCalls`, `distractorCalls` | Interaction counts |
| `errorCounts` | Per-call error kinds |
| `recoveredFromText` | Tool calls or code blocks recovered from plain-text replies (lenient parsing) |
| `promptTokens`, `completionTokens` | Provider-reported totals over all turns |
| `promptChars`, `maxPromptChars`, `firstTurnPromptChars` | Exact request sizes in characters |
| `contextSaturated` | Whether a request likely filled the context window |
| `piiExposed` | Distinct customer emails and phone numbers that reached the model's context |
| `llmLatencyMs`, `wallMs`, `cachedResponses` | Timing, and how many responses came from the local cache |
| `sampling` | Temperature, top-p, context window, thinking flag, turn budget, parsing mode |
| `hardware`, `git`, `harnessVersion`, `taskSetHash`, `startedAt` | Provenance |
