// v3.12.0-rc.2 — deterministic first-run orchestration.
//
// `configure`, `setup`, `install-model`, and `doctor` already own the
// onboarding primitives. This leaf builds one exact argument-vector plan over
// those commands instead of duplicating their implementation. The CLI executes
// each vector without a shell, preserving paths and privacy globs byte-for-byte.

import { buildPrivacyArgs, type ConfigClient, type ConfigTier, renderShellCommand } from "./mcp-config.js";

/** Stable identifiers for the onboarding steps exposed in progress output. */
export type FirstRunStepId = "configure" | "setup" | "reranker" | "doctor";

/** Exact package/executable identity used to invoke every onboarding step. */
export interface FirstRunInvocation {
  /** Executable path or command name. */
  command: string;
  /** Arguments that select the exact enquire-mcp entrypoint/package. */
  argsPrefix: string[];
}

/** Validated inputs used to construct a first-run plan. */
export interface FirstRunPlanInput {
  /** Absolute Obsidian vault path. */
  vault: string;
  /** Capability tier to configure and verify. */
  tier: ConfigTier;
  /** Optional target client; omission prints every supported client config. */
  client?: ConfigClient;
  /** MCP server key used in generated client configuration. */
  name: string;
  /** Whether configure should render the remote HTTP form. */
  http: boolean;
  /** Privacy denylist propagated through configure, setup, and doctor. */
  excludeGlobs?: string[];
  /** Privacy allowlist propagated through configure, setup, and doctor. */
  readPaths?: string[];
  /** Explicit embedding model override passed to setup, when supplied. */
  embeddingModel?: string;
  /** Explicit embedding quantization override passed to setup, when supplied. */
  quantizeEmbeddings?: string;
  /** Exact executable/package identity shared by every child command. */
  invocation: FirstRunInvocation;
}

/** One executable first-run step. */
export interface FirstRunStep {
  /** Stable step identifier. */
  id: FirstRunStepId;
  /** Human-readable progress label. */
  label: string;
  /** Executable path or command name. */
  command: string;
  /** Raw argument vector; never shell-interpolated during execution. */
  args: string[];
  /** Whether preview mode must skip this step. */
  requiresApply: boolean;
  /** Whether the step may create or update indexes/model-cache state. */
  mutatesLocalState: boolean;
}

/** Complete first-run plan plus an idempotent command that resumes it. */
export interface FirstRunPlan {
  /** Ordered configure → setup/model → doctor steps. */
  steps: FirstRunStep[];
  /** Exact self-command that repeats the non-destructive preview. */
  previewCommand: { command: string; args: string[] };
  /** Exact self-command that repeats the plan with explicit apply consent. */
  applyCommand: { command: string; args: string[] };
}

/** Function that executes one raw step and returns its process exit code. */
export type FirstRunStepRunner = (step: FirstRunStep) => Promise<number>;

/** Result of executing either the preview-safe prefix or the full plan. */
export type FirstRunExecutionResult =
  | {
      /** Every selected step completed successfully. */
      ok: true;
      /** Steps that ran and exited zero. */
      completed: FirstRunStepId[];
      /** Steps intentionally omitted in preview mode. */
      skipped: FirstRunStepId[];
    }
  | {
      /** Execution stopped at the first failed step. */
      ok: false;
      /** Steps that completed before the failure. */
      completed: FirstRunStepId[];
      /** Steps intentionally omitted before the failure. */
      skipped: FirstRunStepId[];
      /** Step whose runner failed or exited nonzero. */
      failedStep: FirstRunStep;
      /** Nonzero child exit code; runner exceptions normalize to 1. */
      exitCode: number;
      /** Runner exception text, when process launch itself failed. */
      error?: string;
    };

function commandStep(
  input: FirstRunPlanInput,
  id: FirstRunStepId,
  label: string,
  commandArgs: string[],
  requiresApply: boolean,
  mutatesLocalState: boolean
): FirstRunStep {
  return {
    id,
    label,
    command: input.invocation.command,
    args: [...input.invocation.argsPrefix, ...commandArgs],
    requiresApply,
    mutatesLocalState
  };
}

/**
 * Build the deterministic onboarding plan for one validated vault/tier.
 *
 * `configure` is the only preview-executed step and is non-destructive.
 * Hybrid tiers add idempotent setup + reranker acquisition before doctor;
 * basic goes directly from configure to its read-only doctor check.
 *
 * @param input - Validated first-run inputs and exact invocation identity.
 * @returns Ordered child-process vectors and the exact `--apply` resume command.
 * @example
 * ```ts
 * const plan = buildFirstRunPlan({
 *   vault: "/vault",
 *   tier: "basic",
 *   name: "obsidian",
 *   http: false,
 *   invocation: { command: "node", argsPrefix: ["/pkg/dist/index.js"] }
 * });
 * ```
 */
export function buildFirstRunPlan(input: FirstRunPlanInput): FirstRunPlan {
  const privacyArgs = buildPrivacyArgs(input);
  const configureArgs = [
    "configure",
    "--vault",
    input.vault,
    "--tier",
    input.tier,
    "--name",
    input.name,
    ...(input.client ? ["--client", input.client] : []),
    ...(input.http ? ["--http"] : []),
    ...privacyArgs
  ];
  const setupArgs = [
    "setup",
    "--vault",
    input.vault,
    ...(input.embeddingModel ? ["--embedding-model", input.embeddingModel] : []),
    ...(input.quantizeEmbeddings ? ["--quantize-embeddings", input.quantizeEmbeddings] : []),
    ...(input.tier === "hybrid-live" ? ["--include-pdfs"] : []),
    ...privacyArgs
  ];

  const steps: FirstRunStep[] = [
    commandStep(input, "configure", "Validate the vault and render client configuration", configureArgs, false, false)
  ];
  if (input.tier !== "basic") {
    steps.push(
      commandStep(input, "setup", "Build the FTS5 and embedding indexes", setupArgs, true, true),
      commandStep(input, "reranker", "Cache the verified reranker model", ["install-model", "rerank-bge"], true, true)
    );
  }
  steps.push(
    commandStep(
      input,
      "doctor",
      `Verify ${input.tier} readiness`,
      ["doctor", "--tier", input.tier, "--vault", input.vault, ...privacyArgs],
      true,
      false
    )
  );

  const previewArgs = [
    "first-run",
    "--vault",
    input.vault,
    "--tier",
    input.tier,
    "--name",
    input.name,
    ...(input.client ? ["--client", input.client] : []),
    ...(input.http ? ["--http"] : []),
    ...(input.embeddingModel ? ["--embedding-model", input.embeddingModel] : []),
    ...(input.quantizeEmbeddings ? ["--quantize-embeddings", input.quantizeEmbeddings] : []),
    ...privacyArgs
  ];

  return {
    steps,
    previewCommand: {
      command: input.invocation.command,
      args: [...input.invocation.argsPrefix, ...previewArgs]
    },
    applyCommand: {
      command: input.invocation.command,
      args: [...input.invocation.argsPrefix, ...previewArgs, "--apply"]
    }
  };
}

/**
 * Render a planned child command for human review or recovery instructions.
 *
 * @param step - Planned raw command vector.
 * @param platform - Target interactive shell platform.
 * @returns Shell-safe display form; execution still uses the raw vector.
 * @example
 * ```ts
 * renderFirstRunStep(plan.steps[0], "darwin");
 * ```
 */
export function renderFirstRunStep(step: Pick<FirstRunStep, "command" | "args">, platform?: NodeJS.Platform): string {
  return renderShellCommand(step.command, step.args, platform);
}

/**
 * Execute the preview-safe prefix or the entire first-run plan in order.
 *
 * The executor stops at the first nonzero/launch failure. Re-running the
 * returned plan's `applyCommand` is safe because the stateful child commands
 * are idempotent and completed steps are never rolled back implicitly.
 *
 * @param plan - Plan returned by {@link buildFirstRunPlan}.
 * @param apply - True to execute all steps; false to execute only preview-safe steps.
 * @param runner - Child-process adapter; injectable for deterministic tests.
 * @param onStep - Optional progress callback invoked immediately before a step.
 * @returns Completion/failure ledger with completed and skipped step IDs.
 * @example
 * ```ts
 * await executeFirstRunPlan(plan, false, async () => 0);
 * ```
 */
export async function executeFirstRunPlan(
  plan: FirstRunPlan,
  apply: boolean,
  runner: FirstRunStepRunner,
  onStep?: (step: FirstRunStep, index: number, total: number) => void
): Promise<FirstRunExecutionResult> {
  const completed: FirstRunStepId[] = [];
  const skipped: FirstRunStepId[] = [];

  for (const [index, step] of plan.steps.entries()) {
    if (!apply && step.requiresApply) {
      skipped.push(step.id);
      continue;
    }
    onStep?.(step, index, plan.steps.length);
    let exitCode: number;
    try {
      exitCode = await runner(step);
    } catch (error) {
      return {
        ok: false,
        completed,
        skipped,
        failedStep: step,
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (exitCode !== 0) {
      return { ok: false, completed, skipped, failedStep: step, exitCode };
    }
    completed.push(step.id);
  }

  return { ok: true, completed, skipped };
}
