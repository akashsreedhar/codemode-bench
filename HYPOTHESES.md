# Pre-registered hypotheses and analysis plan

**Status:** registered before any model run. The git history of this file is the record of when each prediction was written. Results that contradict a hypothesis will be reported as they are, and this file will not be edited after the corresponding results are produced. Amendments, if any, go in a dated section at the end.

## Questions

1. Does Code Mode change **task success** compared with direct tool calling, and how does that depend on the number of tools exposed, the length of the call chain, the size of the intermediate data, and model size?
2. Does Code Mode reduce **input tokens per task**, given that its first request is larger (see the static context cost table in the README)?
3. Does Code Mode reduce **exposure of personal data** to the model's context?
4. If Code Mode helps, is that because there are **fewer tool definitions in context** (tested by condition B, tool search) or because **code is a better medium for multi-step work** (tested by C vs. B, and C vs. D)?

## Hypotheses

Each hypothesis is stated with its expected direction. "Supported" means the paired difference has the predicted sign with p < 0.05 (exact McNemar test on matched task × seed pairs). For token and exposure metrics it means a lower mean in the predicted condition. For each hypothesis we will report the observed effect, its interval and its p-value, whether or not it is significant.

| ID | Hypothesis | Predicted direction |
|---|---|---|
| H1 | Code Mode (C) has a **higher success rate than direct calling (A)** on tasks with `chain: loop` or `payload: large`. | C > A |
| H2 | On `chain: single` tasks with `payload: small`, Code Mode is **not better** than direct calling. For the smallest model it is **worse**, because writing correct code is harder than producing one tool call. | C ≤ A; C < A for 1.7B |
| H3 | The success gap between C and A **widens as the tool count grows** (5 → 20 → 50), because direct-mode schemas crowd a small context window. | (C − A) increases with tools |
| H4 | Code Mode uses **fewer total input tokens per task** than direct calling on `payload: large` tasks, and **more** on `payload: small` tasks. | C < A (large); C > A (small) |
| H5 | Code Mode exposes **fewer customer emails and phone numbers** to the model's context on aggregate and privacy tasks. | C < A |
| H6 | The benefit of Code Mode over direct calling is **larger for the 4B model than for the 1.7B model** on loop and large-payload tasks. The smallest model's code-writing errors (syntax errors, hallucinated APIs) offset the gains. | (C − A) at 4B > (C − A) at 1.7B |
| H7 | Tool search (B) **does not match** Code Mode on loop tasks, even though B has the smallest context: reducing tool definitions alone does not remove per-call round trips. | C > B on loop tasks |

H1–H6 are tested in the pilot (`configs/pilot.yaml`). H7 needs condition B and is tested in the full study (`configs/full.yaml`).

## Primary and secondary outcomes

- **Primary:** binary task success from the programmatic verifier.
- **Secondary:**
  - total input tokens reported by the provider, and total request characters (exact)
  - number of turns
  - wall time
  - PII exposure count
  - failure mode: `wrong_result`, `no_answer`, `turn_limit`, `context_overflow`, `time_limit`
  - per-call error kinds: unknown tool, invalid arguments, syntax error, runtime error, hallucinated API, timeout

## Analysis plan

1. Exclude infrastructure errors (`outcome: error`, e.g. provider unreachable) from rates. Report their count.
2. Report success rate with a Wilson 95% interval per model × condition × tool count.
3. Compare conditions with paired comparisons against direct calling on matched (task, seed) pairs at the same tool count, using an exact two-sided McNemar test. With several comparisons, p-values are reported unadjusted, together with the number of comparisons made. Readers should treat isolated p ≈ 0.05 results with caution.
4. Break down results by task category, chain length and payload size. These breakdowns are exploratory unless named in a hypothesis above.
5. Report lenient-parsing recoveries per condition. As a robustness check, recompute success treating every run that needed a recovery as a failure (strict parsing).
6. Do not drop tasks or runs after seeing results. If a task turns out to be defective (for example, a verifier bug), the fix gets a new task-set fingerprint and all conditions are re-run. The old results are not mixed with the new ones.

## Settings fixed in advance

- Models: Qwen3 1.7B and 4B (Ollama default quantisation), `think: false`, temperature 0.7, top-p 0.8 (Qwen3's recommended non-thinking settings), context window 16,384.
- Turn budget 20; tool-result cap 100,000 characters; lenient parsing on.
- Seeds 1–3 for the main grid, seed 1 for the tool-count sweep.
- World seed 1337.

## Amendments

### 2026-10-25: context handling, output cap and run time limit (before any results were reported)

A 35-run smoke start of the pilot showed that, with large tool results, Ollama's default behaviour is to silently truncate the prompt and shift the context window once it fills. The model then continues from partially deleted history. A single run could take more than an hour, and its outcome would reflect discarded context rather than the condition under test. The partial run was discarded (no results from it were analysed or published), and the pilot was restarted from zero with these changes:

1. **No silent truncation.** Requests to Ollama set `truncate: false` and `shift: false`. A request that does not fit the context window now ends the run with failure mode `context_overflow`, which is recorded and reported.
2. **Output cap.** `maxTokens` (Ollama `num_predict`) lowered from 4,096 to 2,048 per turn.
3. **Run time limit.** Each run has a wall-clock safety limit of 900 s (`maxRunSeconds`). Exceeding it ends the run with failure mode `time_limit`. Because this limit depends on hardware speed, `time_limit` failures are reported separately.

The hypotheses, task set, conditions and every other setting are unchanged.
