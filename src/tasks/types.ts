import type { World } from "../world/types.js";
import type { Verification } from "./verify.js";

export type TaskCategory = "lookup" | "aggregate" | "transform" | "write" | "privacy";
/** Approximate number of dependent tool calls a minimal solution needs. */
export type ChainLength = "single" | "short" | "long" | "loop";
/** Size of the intermediate data a minimal solution must process. */
export type PayloadSize = "small" | "large";

export interface VerifyContext<P> {
  params: P;
  initial: World;
  final: World;
  answer: string;
}

export interface TaskDefinition<P = unknown> {
  id: string;
  title: string;
  category: TaskCategory;
  chain: ChainLength;
  payload: PayloadSize;
  /** Core tools a correct solution needs. Always exposed, whatever the tool count. */
  requiredTools: string[];
  /** Part of the smaller pilot subset. */
  pilot?: boolean;
  /** Derive task parameters (IDs, names, …) from the initial world. */
  params(world: World): P;
  prompt(params: P): string;
  verify(ctx: VerifyContext<P>): Verification;
  /**
   * Reference solution as JavaScript using the `codemode.*` API. It returns
   * the final answer. Used to prove solvability and to drive the scripted
   * backend in CI; it is never shown to a model.
   */
  oracle(params: P): string;
}

export const defineTask = <P>(t: TaskDefinition<P>): TaskDefinition<P> => t;
