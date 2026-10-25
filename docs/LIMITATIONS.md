# Limitations and threats to validity

Every benchmark makes trade-offs. These are the ones that matter most when interpreting CodeModeBench results.

## External validity

- **Simulated servers.** The MCP servers are realistic in shape (validated schemas, pagination, verbose records, error messages), but they are not production systems. Latency is near zero, there are no rate limits, and data is clean. Real servers can be slower, flakier and less consistently documented.
- **One domain.** All tasks come from customer operations. Code Mode may behave differently for, say, browser automation or software engineering tools.
- **English only**, with templated data.

## Construct validity

- **Output types favour Code Mode in the prompt.** The generated TypeScript includes return types from MCP `outputSchema`. Native function calling has no standard way to give a model output schemas, so direct mode does not see them; it sees the data itself. This mirrors how each approach is used in practice, and it is why Code Mode's first request is larger. Without output schemas, Code Mode would be cheaper up front but the model would have to guess data shapes.
- **Lenient parsing.** Recovering tool calls or code from plain text helps small models in every condition. Recoveries are counted, so a strict-parsing re-analysis is possible (see `HYPOTHESES.md`).
- **The PII metric is a proxy.** It counts customer emails and phone numbers present in non-system messages. It does not capture names, addresses or data the model infers.
- **Token counts depend on the provider.** Ollama's `prompt_eval_count` can exclude prompt tokens served from its KV cache on later turns. For this reason the harness also records `promptChars`, an exact count of characters sent, which is comparable across conditions and providers.

## Statistical validity

- **Repeated measures.** Runs of the same task under different seeds are not independent. Wilson intervals over all runs are therefore optimistic. Paired McNemar tests on (task, seed) pairs, and the per-task breakdown in the report, are the more reliable views.
- **Small samples in the pilot.** With 15 tasks × 3 seeds per cell, only large differences will be statistically detectable. Treat null results as "no large effect", not "no effect".
- **Multiple comparisons.** p-values are reported unadjusted, together with the number of comparisons.

## Model coverage

- **Small, quantised, open-weight models.** The pilot uses Qwen3 1.7B and 4B at Ollama's default quantisation, which is what runs for free on a laptop. Results may not transfer to larger or closed models, which are the ones the original Code Mode write-ups used. The harness supports any OpenAI-compatible endpoint, so this is a limit of the published runs, not of the tool.
- **One model family in the pilot.** Family-specific training (for example, how much tool-call data the model saw) may drive effects that do not generalise.
- **Context windows.** Local runs use a 16k context window to fit consumer GPUs. Direct mode with many tools and large results can exceed that. This is recorded (`contextSaturated`) and is part of the trade-off being measured, but larger windows may change the picture.

## Implementation choices

- The per-run time limit (900 s) depends on hardware: a slower GPU can turn a long but eventually successful run into a `time_limit` failure. These failures are reported separately so they can be excluded or re-run on faster hardware.
- The turn budget (20) and result cap (100k characters) are design parameters. Different values would shift absolute success rates, especially for loop tasks in direct mode.
- The sandbox runs QuickJS, not V8. Its JavaScript support is close to ES2023, but it is slower than V8 for heavy computation. No task here is computationally heavy.
- Tool search (condition B) uses simple keyword scoring rather than embeddings. A stronger retriever could improve B.
