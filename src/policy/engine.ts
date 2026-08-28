import { z } from "zod";
import {
  ActionTypeSchema,
  RiskLevelSchema,
} from "../schema/capability.js";

export const PolicyConfigSchema = z.object({
  allowedDomains: z.array(z.string()).min(1),
  allowedPathPatterns: z.array(z.string()).default(["*"]),
  allowedActions: z.array(ActionTypeSchema),
  blockedUrlPatterns: z.array(z.string()).default([]),
  irreversibleStepIds: z.array(z.string()).default([]),
  maxStepsPerRun: z.number().default(50),
  requireEscalationForRisk: z.array(RiskLevelSchema).default(["irreversible"]),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const DEFAULT_POLICY: PolicyConfig = {
  allowedDomains: ["localhost:3000", "127.0.0.1:3000"],
  allowedPathPatterns: ["*"],
  allowedActions: [
    "navigate",
    "click",
    "fill",
    "select",
    "press",
    "wait",
    "extract",
    "assert",
  ],
  blockedUrlPatterns: [],
  irreversibleStepIds: [],
  maxStepsPerRun: 50,
  requireEscalationForRisk: ["irreversible"],
};

export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export class PolicyEngine {
  constructor(private config: PolicyConfig = DEFAULT_POLICY) {}

  assertNavigationAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PolicyViolationError(`Invalid URL: ${url}`, "URL_INVALID");
    }
    const host = parsed.host;

    const domainAllowed = this.config.allowedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (!domainAllowed) {
      throw new PolicyViolationError(
        `Navigation to ${host} is not in the allowlist`,
        "DOMAIN_NOT_ALLOWED",
      );
    }

    const pathAllowed = this.config.allowedPathPatterns.some((pattern) =>
      pattern === "*"
        ? true
        : pattern.endsWith("*")
          ? parsed.pathname.startsWith(pattern.slice(0, -1))
          : parsed.pathname === pattern,
    );
    if (!pathAllowed) {
      throw new PolicyViolationError(
        `Path ${parsed.pathname} is not in the allowed path patterns`,
        "PATH_NOT_ALLOWED",
      );
    }

    for (const pattern of this.config.blockedUrlPatterns) {
      if (url.includes(pattern)) {
        throw new PolicyViolationError(
          `URL matches blocked pattern: ${pattern}`,
          "URL_BLOCKED",
        );
      }
    }
  }

  /** Reject artifacts whose step count exceeds the per-run budget. */
  assertStepBudget(stepCount: number): void {
    if (stepCount > this.config.maxStepsPerRun) {
      throw new PolicyViolationError(
        `Artifact has ${stepCount} steps; policy allows at most ${this.config.maxStepsPerRun} per run`,
        "STEP_BUDGET_EXCEEDED",
      );
    }
  }

  assertActionAllowed(action: string, url: string): void {
    if (!this.config.allowedActions.includes(action as never)) {
      throw new PolicyViolationError(
        `Action '${action}' is not permitted`,
        "ACTION_NOT_ALLOWED",
      );
    }
    this.assertNavigationAllowed(url);
  }

  requiresEscalation(riskLevel: string, stepId?: string): boolean {
    if (this.config.requireEscalationForRisk.includes(riskLevel as never)) {
      return true;
    }
    if (stepId && this.config.irreversibleStepIds.includes(stepId)) {
      return true;
    }
    return false;
  }

  get config_snapshot(): PolicyConfig {
    return { ...this.config };
  }
}
