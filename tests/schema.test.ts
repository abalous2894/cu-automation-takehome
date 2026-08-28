import { describe, it, expect } from "vitest";
import {
  CapabilityArtifactSchema,
  resolveStepValue,
  isParamRef,
} from "../src/schema/capability.js";
import { PolicyEngine, PolicyViolationError } from "../src/policy/engine.js";
import {
  EvidenceLogger,
  redactSensitive,
  type StepLogEntry,
} from "../src/evidence/logger.js";
import { isValidDisposition } from "../src/hitl/controller.js";
import { createHash } from "node:crypto";

const SAMPLE_ARTIFACT = {
  schemaVersion: "1.0" as const,
  id: "meridian.lookup_balance",
  name: "Lookup savings balance",
  description: "Look up a member and read their savings balance",
  target: {
    appId: "meridian-core",
    entryUrl: "http://localhost:3000/search",
  },
  parameters: {
    memberId: {
      type: "string" as const,
      description: "Member ID",
      required: true,
      sensitive: false,
    },
  },
  outputs: {
    savingsBalance: {
      type: "number" as const,
      description: "Savings account balance",
      sensitive: false,
    },
  },
  steps: [
    {
      id: "step_1",
      action: "fill" as const,
      description: "Enter member ID",
      target: {
        strategies: [{ type: "label" as const, value: "Member #", match: "exact" as const }],
      },
      value: { $param: "memberId" },
      riskLevel: "safe" as const,
    },
  ],
  successCheckpoint: {
    type: "text_present" as const,
    value: "Account Summary",
  },
  errorHandlers: [],
  metadata: {
    recordedAt: new Date().toISOString(),
    recordedBy: "discovery" as const,
    surfaceType: "web" as const,
    riskProfile: "read_only" as const,
  },
};

describe("CapabilityArtifactSchema", () => {
  it("validates a well-formed artifact", () => {
    const result = CapabilityArtifactSchema.safeParse(SAMPLE_ARTIFACT);
    expect(result.success).toBe(true);
  });

  it("rejects artifact with no steps", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...SAMPLE_ARTIFACT,
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a role strategy without a role field", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...SAMPLE_ARTIFACT,
      steps: [
        {
          ...SAMPLE_ARTIFACT.steps[0],
          target: { strategies: [{ type: "role", value: "Search", match: "exact" }] },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a text_present checkpoint without a value", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...SAMPLE_ARTIFACT,
      successCheckpoint: { type: "text_present" },
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveStepValue", () => {
  it("resolves param references", () => {
    expect(resolveStepValue({ $param: "memberId" }, { memberId: "12345" })).toBe(
      "12345",
    );
  });

  it("returns literal strings unchanged", () => {
    expect(resolveStepValue("hello", {})).toBe("hello");
  });

  it("throws on missing param", () => {
    expect(() => resolveStepValue({ $param: "memberId" }, {})).toThrow(
      "Missing required parameter",
    );
  });
});

describe("isParamRef", () => {
  it("identifies param refs", () => {
    expect(isParamRef({ $param: "memberId" })).toBe(true);
    expect(isParamRef("literal")).toBe(false);
  });
});

describe("PolicyEngine", () => {
  const policy = new PolicyEngine();

  it("allows localhost navigation", () => {
    expect(() =>
      policy.assertNavigationAllowed("http://localhost:3000/search"),
    ).not.toThrow();
  });

  it("blocks external domains", () => {
    expect(() =>
      policy.assertNavigationAllowed("https://evil.com"),
    ).toThrow(PolicyViolationError);
  });

  it("requires escalation for irreversible steps", () => {
    expect(policy.requiresEscalation("irreversible")).toBe(true);
    expect(policy.requiresEscalation("safe")).toBe(false);
  });
});

describe("redactSensitive", () => {
  it("redacts sensitive keys", () => {
    const result = redactSensitive(
      { memberId: "12345", ssn: "123-45-6789" },
      new Set(["ssn"]),
    );
    expect(result.memberId).toBe("12345");
    expect(result.ssn).toBe("[REDACTED]");
  });
});

describe("intervention dispositions fail closed", () => {
  it("accepts only the three known dispositions", () => {
    expect(isValidDisposition("approved")).toBe(true);
    expect(isValidDisposition("performed_manually")).toBe(true);
    expect(isValidDisposition("abort")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidDisposition("yolo_approve")).toBe(false);
    expect(isValidDisposition("")).toBe(false);
    expect(isValidDisposition(undefined)).toBe(false);
    expect(isValidDisposition({ disposition: "approved" })).toBe(false);
  });
});

describe("hash-chained audit log", () => {
  function makeChain(actions: string[]): StepLogEntry[] {
    let prev = "genesis";
    return actions.map((action, index) => {
      const entry: StepLogEntry = {
        index,
        action,
        timestamp: "2026-08-27T00:00:00.000Z",
        prevHash: prev,
      };
      entry.hash = createHash("sha256")
        .update(JSON.stringify(entry))
        .digest("hex");
      prev = entry.hash;
      return entry;
    });
  }

  it("verifies an intact chain", () => {
    const chain = makeChain(["navigate", "fill", "click"]);
    expect(EvidenceLogger.verifyChain(chain)).toBe(-1);
  });

  it("detects a tampered entry", () => {
    const chain = makeChain(["navigate", "fill", "click"]);
    chain[1].action = "delete_account"; // tamper
    expect(EvidenceLogger.verifyChain(chain)).toBe(1);
  });

  it("detects a deleted entry", () => {
    const chain = makeChain(["navigate", "fill", "click"]);
    chain.splice(1, 1);
    expect(EvidenceLogger.verifyChain(chain)).toBe(1);
  });

  it("accepts multiple run segments in one file", () => {
    const combined = [...makeChain(["navigate", "fill"]), ...makeChain(["navigate", "click"])];
    expect(EvidenceLogger.verifyChain(combined)).toBe(-1);
  });
});
