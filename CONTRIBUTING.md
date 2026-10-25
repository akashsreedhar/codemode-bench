# Contributing

Contributions are welcome: new tasks, conditions, providers, analyses and, above all, results from models and hardware we have not covered.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run bench:ci     # all tasks × all conditions through reference solutions
```

All four checks must pass before a pull request is merged; CI runs them on Node 20 and 22.

## Adding a task

Tasks live in `src/tasks/suite.ts` and are defined with `defineTask`:

1. **`params(world)`** derives everything the task needs (IDs, expected values) from the initial world. Never hard-code values that depend on generated data.
2. **`prompt(params)`** is the instruction given to the model. Write it as a real operator would, and do not hint at the solution strategy.
3. **`verify(ctx)`** checks the final answer and/or the final world state, using the helpers in `src/tasks/verify.ts`. Reject collateral changes for write tasks.
4. **`oracle(params)`** is a reference solution in JavaScript using `codemode.*` (and the `fetchAll` pagination helper). It must pass under every condition.
5. **`requiredTools`** lists every core tool the solution needs.

The test suite then checks that the oracle passes under all four conditions and that an agent that does nothing fails. Adding or changing a task changes the task-set fingerprint, so results from before and after the change are never mixed.

Then regenerate the task list:

```bash
npm run tasks -- --markdown docs/TASKS.md
```

## Contributing results

1. Run a config unchanged, or add a new config under `configs/`, from a clean git checkout. The results record the commit and a dirty flag.
2. Commit `results/<experiment>/runs.jsonl`, `manifest.json` and `traces/`.
3. Run `npm run report` and commit the regenerated `reports/` and README results section.

Never edit result files or the generated README section by hand.

## Pre-registration

New hypotheses go in `HYPOTHESES.md` *before* the runs that test them. Changes after the fact go in the dated "Amendments" section.
