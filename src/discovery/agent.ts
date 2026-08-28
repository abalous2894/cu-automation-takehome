import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { isParamRef, type CapabilityArtifact, type Step } from "../schema/capability.js";
import { EvidenceLogger } from "../evidence/logger.js";
import { PolicyEngine } from "../policy/engine.js";
import { HitlController } from "../hitl/controller.js";
import { SessionManager } from "../session/manager.js";
import { PlaywrightSurfaceAdapter, surfaceAction } from "../surface/playwright-adapter.js";
import type { SurfaceAction } from "../surface/types.js";

const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an element by its aria-ref from the current snapshot",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref, e.g. e6" },
        description: { type: "string", description: "What you are clicking and why" },
      },
      required: ["ref", "description"],
    },
  },
  {
    name: "fill",
    description: "Type text into an input field",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string", description: "Text to type, or $param:name for parameterized values" },
        description: { type: "string" },
      },
      required: ["ref", "value", "description"],
    },
  },
  {
    name: "press",
    description: "Press a keyboard key",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. Enter, Tab" },
        description: { type: "string" },
      },
      required: ["key", "description"],
    },
  },
  {
    name: "navigate",
    description: "Navigate to a URL (must be on allowlist)",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        description: { type: "string" },
      },
      required: ["url", "description"],
    },
  },
  {
    name: "done",
    description: "Goal is complete. Provide extracted outputs.",
    input_schema: {
      type: "object",
      properties: {
        outputs: {
          type: "object",
          description: "Key-value pairs of extracted data",
          additionalProperties: { type: "string" },
        },
        summary: { type: "string" },
        checkpoint_text: {
          type: "string",
          description:
            "A short, stable text visible on the final page that proves the goal state was reached (e.g. a heading like 'Account Summary'). Do NOT use data values that change per member.",
        },
      },
      required: ["outputs", "summary", "checkpoint_text"],
    },
  },
  {
    name: "escalate",
    description: "Request human intervention — stuck, risky action, or unexpected state",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

const SYSTEM_PROMPT = `You are a computer-use agent operating a legacy credit union back-office application.

Rules:
1. You receive an accessibility tree snapshot with [ref=eN] identifiers for interactive elements.
2. ALWAYS cite the ref from the current snapshot when clicking or filling. Refs are invalid after page changes — re-read the snapshot after every action.
3. Type the ACTUAL values given in the input parameters (e.g. the real member ID). The system parameterizes the recording automatically afterward.
4. Call "done" only when the goal is fully achieved and you have extracted all required data. Include a checkpoint_text: stable page text (a heading or label) that proves success — never a data value.
5. Call "escalate" if stuck (same action failed 2+ times), if you see an unexpected dialog, or before any irreversible action (submit, delete, transfer).
6. Read-only operations are preferred. Do not submit forms unless the goal requires it.`;

export interface DiscoveryOptions {
  goal: string;
  targetUrl: string;
  outputDir: string;
  /**
   * Test values for the capability's input parameters, e.g. { memberId: "12345" }.
   * The agent types these real values during discovery; the recorder then
   * canonicalizes any recorded value that matches into a { $param } reference
   * so the artifact is reusable with different inputs.
   */
  params?: Record<string, string>;
  maxSteps?: number;
  headless?: boolean;
  model?: string;
}

export interface DiscoveryResult {
  success: boolean;
  artifact?: CapabilityArtifact;
  outputs?: Record<string, string>;
  runId: string;
  stepsRecorded: number;
  escalated?: boolean;
  interventionId?: string;
}

export class DiscoveryAgent {
  private client: Anthropic;
  private policy = new PolicyEngine();
  private hitl = new HitlController();

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async run(opts: DiscoveryOptions): Promise<DiscoveryResult> {
    const maxSteps = opts.maxSteps ?? parseInt(process.env.DISCOVERY_MAX_STEPS ?? "25", 10);
    const model = opts.model ?? process.env.DISCOVERY_MODEL ?? "claude-sonnet-5";
    const headless = opts.headless ?? process.env.HEADLESS !== "false";

    const evidence = new EvidenceLogger("discovery", opts.outputDir, {
      goal: opts.goal,
      initiatedBy: "agent",
    });
    await evidence.init();

    const browser = await chromium.launch({ headless });
    const { adapter, page } = await PlaywrightSurfaceAdapter.create(browser, {
      headless,
      policy: this.policy,
    });
    const context = page.context();
    const session = new SessionManager(browser, context, page);
    session.startAutomation();

    const recordedSteps: Step[] = [];
    let stepCounter = 0;

    try {
      this.policy.assertNavigationAllowed(opts.targetUrl);
      await adapter.execute(surfaceAction("navigate", { value: opts.targetUrl }));
      await evidence.logStep({
        action: "navigate",
        description: `Navigate to ${opts.targetUrl}`,
        url: page.url(),
      });

      const paramsBlock = opts.params
        ? `\n\nInput parameters (type these actual values where needed):\n${Object.entries(
            opts.params,
          )
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")}`
        : "";

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: `Goal: ${opts.goal}${paramsBlock}\n\nTarget URL: ${opts.targetUrl}\n\nBegin by observing the page and working toward the goal.`,
        },
      ];

      let outputs: Record<string, string> | undefined;
      let checkpointText: string | undefined;

      for (let i = 0; i < maxSteps; i++) {
        session.assertAgentControl();
        const observation = await adapter.observe();
        await evidence.saveSnapshot(observation.snapshot, `step-${i}`);

        messages.push({
          role: "user",
          content: `Current page snapshot:\n${observation.snapshot}\n\nURL: ${observation.url}`,
        });

        const response = await this.client.messages.create({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: DISCOVERY_TOOLS,
          messages,
        });

        messages.push({ role: "assistant", content: response.content });

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (toolUses.length === 0) break;

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          const input = toolUse.input as Record<string, unknown>;
          const startMs = Date.now();

          if (toolUse.name === "done") {
            outputs = input.outputs as Record<string, string>;
            checkpointText = input.checkpoint_text
              ? String(input.checkpoint_text)
              : undefined;
            await evidence.logStep({
              action: "done",
              description: String(input.summary ?? "Goal complete"),
              durationMs: Date.now() - startMs,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Recorded.",
            });
            break;
          }

          if (toolUse.name === "escalate") {
            const intervention = await this.hitl.requestIntervention(session, page, {
              reason: String(input.reason),
              goal: opts.goal,
              snapshot: observation.snapshot,
            });
            await evidence.saveResult({
              status: "escalated",
              interventionId: intervention.id,
            });
            return {
              success: false,
              runId: evidence.runId,
              stepsRecorded: recordedSteps.length,
              escalated: true,
              interventionId: intervention.id,
            };
          }

          const surfaceAction_ = toolInputToSurfaceAction(toolUse.name, input);
          // For navigate, the policy must validate the DESTINATION the model
          // asked for — validating the current URL would let the LLM leave
          // the allowlist. Other actions are checked against the current page.
          // A violation is returned to the model as a tool error (recorded in
          // evidence) rather than crashing the run — the guardrail blocks the
          // action and the model can try a compliant path.
          try {
            this.policy.assertActionAllowed(
              surfaceAction_.action,
              surfaceAction_.action === "navigate"
                ? surfaceAction_.value!
                : page.url(),
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await evidence.logStep({
              action: "policy_blocked",
              description: `Blocked ${surfaceAction_.action}: ${message}`,
              url: page.url(),
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Blocked by policy: ${message}`,
              is_error: true,
            });
            continue;
          }

          // Capture the durable locator BEFORE executing: the action may
          // navigate, which invalidates aria-refs from the current snapshot.
          let capturedTarget;
          if (input.ref) {
            try {
              capturedTarget = await adapter.captureTargetFromRef(String(input.ref));
            } catch {
              capturedTarget = undefined;
            }
          }

          await adapter.execute(surfaceAction_);

          const step: Step = {
            id: `step_${++stepCounter}`,
            action: surfaceAction_.action,
            description: String(input.description ?? toolUse.name),
            target: capturedTarget,
            value: input.value ? String(input.value) : undefined,
            riskLevel: "safe",
            timeoutMs: 10000,
            optional: false,
          };
          recordedSteps.push(step);

          await evidence.logStep({
            stepId: step.id,
            action: step.action,
            description: step.description,
            url: page.url(),
            durationMs: Date.now() - startMs,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Action executed successfully.",
          });
        }

        messages.push({ role: "user", content: toolResults });

        if (outputs) break;
      }

      if (!outputs || recordedSteps.length === 0) {
        await evidence.finalize({ success: false });
        return {
          success: false,
          runId: evidence.runId,
          stepsRecorded: recordedSteps.length,
        };
      }

      // Canonicalize: replace recorded literal values that match a supplied
      // test parameter with { $param } references so the artifact is reusable.
      const parameterizedSteps = parameterizeSteps(recordedSteps, opts.params ?? {});

      // Derive label-anchored extraction patterns from the final page state
      // so replay can extract the same outputs for different inputs.
      const finalPageText = await page.locator("body").innerText().catch(() => "");

      const artifact: CapabilityArtifact = {
        schemaVersion: "1.0",
        id: inferCapabilityId(opts.goal),
        name: inferCapabilityName(opts.goal),
        description: opts.goal,
        target: {
          appId: "meridian-core",
          vendor: "Meridian Systems",
          entryUrl: opts.targetUrl,
        },
        parameters: inferParameters(opts.params ?? {}, parameterizedSteps),
        outputs: inferOutputs(outputs, finalPageText),
        steps: parameterizedSteps,
        successCheckpoint: {
          type: "text_present",
          value: checkpointText ?? "success",
          timeoutMs: 10000,
        },
        errorHandlers: [
          {
            id: "member_not_found",
            detect: { type: "text_present", value: "No member found" },
            response: {
              kind: "business_outcome",
              code: "MEMBER_NOT_FOUND",
              message: "The requested member ID does not exist",
            },
          },
          {
            id: "session_timeout",
            detect: { type: "dialog_present", value: "Session expired" },
            response: {
              kind: "recoverable",
              code: "SESSION_TIMEOUT",
              message: "Session expired — attempting recovery",
              recoveryAction: { action: "click", value: "OK" },
            },
          },
        ],
        metadata: {
          recordedAt: new Date().toISOString(),
          recordedBy: "discovery",
          surfaceType: "web",
          riskProfile: "read_only",
          discoveryModel: model,
          discoveryGoal: opts.goal,
        },
      };

      await evidence.saveArtifact("capability.json", artifact);
      await evidence.saveResult({ status: "success", outputs });
      await evidence.finalize({ success: true, stepsRecorded: recordedSteps.length });

      return {
        success: true,
        artifact,
        outputs,
        runId: evidence.runId,
        stepsRecorded: recordedSteps.length,
      };
    } finally {
      await session.close();
    }
  }
}

function toolInputToSurfaceAction(
  toolName: string,
  input: Record<string, unknown>,
): SurfaceAction {
  switch (toolName) {
    case "click":
      return {
        action: "click",
        ref: String(input.ref),
        description: String(input.description),
      };
    case "fill":
      return {
        action: "fill",
        ref: String(input.ref),
        value: String(input.value),
        description: String(input.description),
      };
    case "press":
      return {
        action: "press",
        value: String(input.key),
        description: String(input.description),
      };
    case "navigate":
      return {
        action: "navigate",
        value: String(input.url),
        description: String(input.description),
      };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function inferCapabilityId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);
  return `meridian.${slug}`;
}

function inferCapabilityName(goal: string): string {
  return goal.slice(0, 80);
}

/**
 * Replace literal step values that exactly match a supplied test parameter
 * with { $param } references. This is what makes the recording reusable:
 * discovery types "12345", the artifact stores { $param: "memberId" }.
 *
 * Descriptions are scrubbed too — the LLM writes things like "Enter member
 * ID 12345", and a test value surviving in free text would put PII into the
 * artifact that value-level parameterization claims to keep out.
 */
function parameterizeSteps(
  steps: Step[],
  testParams: Record<string, string>,
): Step[] {
  const valueToParam = new Map(
    Object.entries(testParams).map(([name, value]) => [value, name]),
  );

  const scrubText = (text: string): string => {
    let scrubbed = text;
    for (const [value, name] of valueToParam) {
      if (value) scrubbed = scrubbed.split(value).join(`<${name}>`);
    }
    return scrubbed;
  };

  return steps.map((step) => {
    const next = { ...step, description: scrubText(step.description) };
    if (typeof next.value === "string" && valueToParam.has(next.value)) {
      next.value = { $param: valueToParam.get(next.value as string)! } as Step["value"];
    }
    return next;
  });
}

function inferParameters(
  testParams: Record<string, string>,
  steps: Step[],
): CapabilityArtifact["parameters"] {
  const params: CapabilityArtifact["parameters"] = {};

  // Only declare parameters that are actually referenced by a step —
  // an unused parameter in the contract would mislead the calling agent.
  const referenced = new Set(
    steps
      .map((s) => (isParamRef(s.value) ? s.value.$param : null))
      .filter((name): name is string => name !== null),
  );

  for (const name of Object.keys(testParams)) {
    if (!referenced.has(name)) continue;
    params[name] = {
      type: "string",
      description: `Parameter: ${name}`,
      required: true,
      sensitive: /ssn|password|secret|token/i.test(name),
    };
  }
  return params;
}

function inferOutputs(
  outputs: Record<string, string>,
  finalPageText: string,
): CapabilityArtifact["outputs"] {
  return Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [
      key,
      {
        type: (typeof value === "number" ? "number" : "string") as "string" | "number",
        description: `Extracted: ${key}`,
        sensitive: key.toLowerCase().includes("name") || key.toLowerCase().includes("ssn"),
        extract: deriveExtractionPattern(String(value), finalPageText),
      },
    ]),
  );
}

/**
 * Find the output value in the final page text and derive a regex anchored
 * to the label that precedes it (same line, tab/whitespace separated).
 * "Savings\t$8420.50" → /Savings[ \t]+([^\n\t]+)/
 */
function deriveExtractionPattern(
  value: string,
  pageText: string,
): { pattern: string } | undefined {
  if (!value || !pageText.includes(value)) return undefined;

  const line = pageText
    .split("\n")
    .find((l) => l.includes(value));
  if (!line) return undefined;

  const valueStart = line.indexOf(value);
  const label = line.slice(0, valueStart).trim();
  if (!label) return undefined;

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { pattern: `${escapedLabel}[ \\t]+([^\\n\\t]+)` };
}
