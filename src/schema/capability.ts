import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

export const ParameterTypeSchema = z.enum(["string", "number", "boolean"]);
export type ParameterType = z.infer<typeof ParameterTypeSchema>;

export const ParameterDefSchema = z.object({
  type: ParameterTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false),
});
export type ParameterDef = z.infer<typeof ParameterDefSchema>;

export const OutputDefSchema = z.object({
  type: ParameterTypeSchema,
  description: z.string(),
  sensitive: z.boolean().default(false),
  /**
   * How to extract this output from the final page. The pattern is a regex
   * with one capture group, applied to the page's inner text. Derived
   * automatically during discovery from label proximity (e.g. "Savings\t$X"
   * → /Savings[\s\t]+([^\n\t]+)/).
   */
  extract: z
    .object({
      pattern: z.string(),
    })
    .optional(),
});
export type OutputDef = z.infer<typeof OutputDefSchema>;

export const RiskLevelSchema = z.enum(["safe", "reversible", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ActionTypeSchema = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "extract",
  "assert",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const LocatorStrategyTypeSchema = z.enum([
  "role",
  "label",
  "placeholder",
  "text",
  "xpath",
  "css",
]);
export type LocatorStrategyType = z.infer<typeof LocatorStrategyTypeSchema>;

export const LocatorStrategySchema = z
  .object({
    type: LocatorStrategyTypeSchema,
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string(),
    match: z.enum(["exact", "contains"]).default("exact"),
  })
  .refine((s) => s.type !== "role" || Boolean(s.role), {
    message: "role strategies require a 'role' field",
  });
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const ElementTargetSchema = z.object({
  strategies: z.array(LocatorStrategySchema).min(1),
  framePath: z.array(z.string()).optional(),
});
export type ElementTarget = z.infer<typeof ElementTargetSchema>;

export const ParamRefSchema = z.object({ $param: z.string() });
export type ParamRef = z.infer<typeof ParamRefSchema>;

export const StepValueSchema = z.union([z.string(), ParamRefSchema]);

export const CheckpointTypeSchema = z.enum([
  "text_present",
  "text_absent",
  "element_visible",
  "url_matches",
  "extract_match",
]);
export type CheckpointType = z.infer<typeof CheckpointTypeSchema>;

export const CheckpointSchema = z
  .object({
    type: CheckpointTypeSchema,
    value: z.string().optional(),
    target: ElementTargetSchema.optional(),
    output: z.string().optional(),
    pattern: z.string().optional(),
    timeoutMs: z.number().default(10000),
  })
  .refine(
    (c) =>
      !["text_present", "text_absent", "url_matches"].includes(c.type) ||
      Boolean(c.value),
    { message: "text/url checkpoints require a 'value'" },
  )
  .refine((c) => c.type !== "element_visible" || Boolean(c.target), {
    message: "element_visible checkpoints require a 'target'",
  })
  .refine(
    (c) => c.type !== "extract_match" || Boolean(c.pattern) || Boolean(c.output),
    { message: "extract_match checkpoints require 'pattern' or 'output'" },
  );
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const StepSchema = z.object({
  id: z.string(),
  action: ActionTypeSchema,
  description: z.string(),
  target: ElementTargetSchema.optional(),
  value: StepValueSchema.optional(),
  checkpoint: CheckpointSchema.optional(),
  riskLevel: RiskLevelSchema.default("safe"),
  timeoutMs: z.number().default(10000),
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof StepSchema>;

export const ErrorHandlerSchema = z.object({
  id: z.string(),
  detect: z.object({
    type: z.enum(["text_present", "text_absent", "dialog_present", "url_matches"]),
    value: z.string(),
  }),
  response: z.object({
    kind: z.enum(["business_outcome", "recoverable", "escalate"]),
    code: z.string().optional(),
    message: z.string().optional(),
    recoveryAction: z
      .object({
        action: ActionTypeSchema,
        target: ElementTargetSchema.optional(),
        value: z.string().optional(),
      })
      .optional(),
  }),
});
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;

export const CapabilityTargetSchema = z.object({
  appId: z.string(),
  vendor: z.string().optional(),
  entryUrl: z.string(),
  minVersion: z.string().optional(),
});
export type CapabilityTarget = z.infer<typeof CapabilityTargetSchema>;

export const CapabilityMetadataSchema = z.object({
  recordedAt: z.string().datetime(),
  recordedBy: z.enum(["discovery", "human"]),
  surfaceType: z.enum(["web", "desktop"]).default("web"),
  riskProfile: z.enum(["read_only", "mutating", "irreversible"]).default("read_only"),
  discoveryModel: z.string().optional(),
  discoveryGoal: z.string().optional(),
});
export type CapabilityMetadata = z.infer<typeof CapabilityMetadataSchema>;

// ---------------------------------------------------------------------------
// Capability artifact — the agent-invocable contract
// ---------------------------------------------------------------------------

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  target: CapabilityTargetSchema,
  parameters: z.record(z.string(), ParameterDefSchema),
  outputs: z.record(z.string(), OutputDefSchema),
  steps: z.array(StepSchema).min(1),
  successCheckpoint: CheckpointSchema,
  errorHandlers: z.array(ErrorHandlerSchema).default([]),
  metadata: CapabilityMetadataSchema,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

// ---------------------------------------------------------------------------
// Replay result contract — three-tier error taxonomy
// ---------------------------------------------------------------------------

export const ReplaySuccessSchema = z.object({
  status: z.literal("success"),
  outputs: z.record(z.string(), z.unknown()),
  runId: z.string(),
  durationMs: z.number(),
  stepsExecuted: z.number(),
  // IDs of interventions a human resolved during this run, if any
  interventions: z.array(z.string()).optional(),
  // Steps where a fallback locator strategy was needed — UI drift signal.
  // A run that succeeds with drift warnings should flag the artifact for review.
  driftWarnings: z
    .array(
      z.object({
        step: z.string(),
        primaryStrategy: z.string(),
        resolvedWith: z.string(),
      }),
    )
    .optional(),
  // Steps recovered by a single bounded LLM call (assisted fallback)
  assistedRecoveries: z.array(z.string()).optional(),
});

export const ReplayBusinessOutcomeSchema = z.object({
  status: z.literal("business_outcome"),
  code: z.string(),
  message: z.string(),
  step: z.string(),
  runId: z.string(),
});

export const ReplayRecoverableSchema = z.object({
  status: z.literal("recoverable"),
  condition: z.string(),
  action: z.string(),
  recovered: z.boolean(),
  runId: z.string(),
});

/**
 * Sub-classification of hard failures. "element not found" alone is
 * undecidable — it is produced equally by selector drift, a transient env
 * issue, and a real app change. Each class implies a different response:
 * - locator_miss: no strategy resolved → drift; re-record or heal the artifact
 * - timeout: transient/env → retry policy applies
 * - checkpoint_mismatch: action executed but state is wrong → app change or bug
 * - policy_violation: blocked by guardrails → review the policy or the artifact
 * - invalid_input: caller-supplied parameters fail the artifact contract → fix the call
 */
export const FailureClassSchema = z.enum([
  "locator_miss",
  "timeout",
  "checkpoint_mismatch",
  "policy_violation",
  "invalid_input",
  "unknown",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const ReplayFailureSchema = z.object({
  status: z.literal("failure"),
  step: z.string(),
  failureClass: FailureClassSchema,
  expected: z.string(),
  observed: z.string(),
  runId: z.string(),
  evidence: z
    .object({
      screenshot: z.string().optional(),
      snapshot: z.string().optional(),
    })
    .optional(),
});

export const ReplayEscalatedSchema = z.object({
  status: z.literal("escalated"),
  interventionId: z.string(),
  reason: z.string(),
  runId: z.string(),
});

export const ReplayResultSchema = z.discriminatedUnion("status", [
  ReplaySuccessSchema,
  ReplayBusinessOutcomeSchema,
  ReplayRecoverableSchema,
  ReplayFailureSchema,
  ReplayEscalatedSchema,
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isParamRef(value: unknown): value is ParamRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "$param" in value &&
    typeof (value as ParamRef).$param === "string"
  );
}

export function resolveStepValue(
  value: string | ParamRef,
  params: Record<string, unknown>,
): string {
  if (isParamRef(value)) {
    const resolved = params[value.$param];
    if (resolved === undefined || resolved === null) {
      throw new Error(`Missing required parameter: ${value.$param}`);
    }
    return String(resolved);
  }
  return value;
}

export function artifactToToolDefinition(artifact: CapabilityArtifact) {
  return {
    name: artifact.id.replace(/\./g, "_"),
    description: artifact.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(artifact.parameters).map(([key, def]) => [
          key,
          { type: def.type, description: def.description },
        ]),
      ),
      required: Object.entries(artifact.parameters)
        .filter(([, def]) => def.required)
        .map(([key]) => key),
    },
  };
}
