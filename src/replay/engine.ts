import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import {
  CapabilityArtifactSchema,
  resolveStepValue,
  type CapabilityArtifact,
  type Checkpoint,
  type FailureClass,
  type ReplayResult,
  type Step,
} from "../schema/capability.js";
import { EvidenceLogger, redactSensitive } from "../evidence/logger.js";
import { PolicyEngine, PolicyViolationError } from "../policy/engine.js";
import { HitlController } from "../hitl/controller.js";
import { SessionManager } from "../session/manager.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright-adapter.js";
import {
  LocatorMissError,
  resolveLocator,
  resolveLocatorDetailed,
} from "../surface/types.js";

export interface ReplayOptions {
  capability: CapabilityArtifact | string;
  params: Record<string, unknown>;
  outputDir: string;
  headless?: boolean;
  times?: number;
  /** How long to hold the live session waiting for an operator (default 5 min) */
  interventionTimeoutMs?: number;
  /**
   * Assisted fallback: on a locator miss, allow ONE bounded, policy-checked
   * LLM call to re-resolve that single step using its recorded intent,
   * recorded as evidence. Never open-ended. Off by default.
   */
  assist?: boolean;
}

interface StepExecution {
  strategyUsed?: string;
  usedFallback?: boolean;
  primaryStrategy?: string;
}

function describeStrategy(s: { type: string; role?: string; name?: string; value: string }): string {
  return s.type === "role" ? `role=${s.role} name=${s.name ?? s.value}` : `${s.type}=${s.value}`;
}

function classifyError(err: unknown): FailureClass {
  if (err instanceof LocatorMissError) return "locator_miss";
  if (err instanceof PolicyViolationError) return "policy_violation";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "unknown";
}

export class ReplayEngine {
  private policy = new PolicyEngine();
  private hitl = new HitlController();

  async run(opts: ReplayOptions): Promise<ReplayResult> {
    const artifact =
      typeof opts.capability === "string"
        ? CapabilityArtifactSchema.parse(
            JSON.parse(await readFile(opts.capability, "utf-8")),
          )
        : CapabilityArtifactSchema.parse(opts.capability);

    const headless = opts.headless ?? process.env.HEADLESS !== "false";
    const startMs = Date.now();

    const sensitiveKeys = new Set([
      ...Object.entries(artifact.parameters)
        .filter(([, def]) => def.sensitive)
        .map(([key]) => key),
      ...Object.entries(artifact.outputs)
        .filter(([, def]) => def.sensitive)
        .map(([key]) => key),
    ]);

    const evidence = new EvidenceLogger("replay", opts.outputDir, {
      capabilityId: artifact.id,
      initiatedBy: "cli",
    });
    await evidence.init();

    // Pre-flight: validate the call against the artifact contract and policy
    // budget BEFORE launching a browser. Bad input is the caller's failure,
    // classified as such — not a mid-run "unknown".
    const preflightError = this.validateInputs(artifact, opts.params);
    if (preflightError) {
      const result: ReplayResult = {
        status: "failure",
        step: "preflight",
        failureClass: preflightError.failureClass,
        expected: "Invocation matching the artifact contract and policy",
        observed: preflightError.message,
        runId: evidence.runId,
      };
      await evidence.saveResult(result);
      return result;
    }

    const browser = await chromium.launch({ headless });
    const { adapter, page } = await PlaywrightSurfaceAdapter.create(browser, {
      headless,
      policy: this.policy,
    });
    const session = new SessionManager(browser, page.context(), page);
    session.startAutomation();

    try {
      // Check error handlers before starting steps
      for (const handler of artifact.errorHandlers) {
        const detected = await this.detectCondition(page, handler.detect, artifact);
        if (detected) {
          const outcome = await this.handleErrorResponse(handler, evidence.runId, artifact, page, session, evidence);
          if (outcome) return outcome;
          // null → condition recovered; continue the run
        }
      }

      this.policy.assertNavigationAllowed(artifact.target.entryUrl);
      await page.goto(artifact.target.entryUrl, { waitUntil: "domcontentloaded" });

      let stepsExecuted = 0;
      const outputs: Record<string, unknown> = {};
      const resolvedInterventions: string[] = [];
      const driftWarnings: NonNullable<
        Extract<ReplayResult, { status: "success" }>["driftWarnings"]
      > = [];
      const assistedRecoveries: string[] = [];

      for (const step of artifact.steps) {
        session.assertAgentControl();

        if (this.policy.requiresEscalation(step.riskLevel, step.id)) {
          // Pause automation, keep the browser session alive, and block until
          // a human resolves the intervention (or we time out). The human
          // operates the SAME live session — cookies, form state, and
          // navigation history are preserved across the handoff.
          const observation = await adapter.observe();
          const sensitiveValue =
            typeof step.value === "object" &&
            step.value !== null &&
            "$param" in step.value &&
            sensitiveKeys.has(step.value.$param);
          const resolvedValue = step.value
            ? resolveStepValue(step.value, opts.params)
            : undefined;
          const intervention = await this.hitl.requestIntervention(session, page, {
            reason: `Irreversible step requires human approval: ${step.description}`,
            capabilityId: artifact.id,
            currentStep: step.id,
            // Decision packet: the reviewer sees the exact action with
            // resolved parameters, not a paraphrase of it.
            proposedAction: {
              action: step.action,
              targetDescription: step.description,
              resolvedValue: sensitiveValue ? "***REDACTED***" : resolvedValue,
              riskLevel: step.riskLevel,
            },
            snapshot: observation.snapshot,
          });

          console.log(`\n⏸  Automation paused — human intervention required`);
          console.log(`   Step:   ${step.id} (${step.description})`);
          console.log(`   Review: npm run operator -- --intervention ${intervention.id}`);
          console.log(`   Waiting for operator resolution...`);

          const resolution = await this.hitl.awaitResolution(intervention.id, {
            timeoutMs: opts.interventionTimeoutMs ?? 300_000,
          });

          // Fail closed: only an explicit, recognized approval may execute
          // the gated step. Timeout, abort, and any unrecognized disposition
          // (e.g. a tampered resolution.json) all stop the run.
          const disposition =
            resolution &&
            ["approved", "performed_manually"].includes(resolution.disposition)
              ? resolution.disposition
              : "abort";
          if (disposition === "abort") {
            const result: ReplayResult = {
              status: "escalated",
              interventionId: intervention.id,
              reason: !resolution
                ? `Intervention timed out: ${step.description}`
                : resolution.disposition === "abort"
                  ? `Operator aborted: ${resolution.notes ?? step.description}`
                  : `Unrecognized disposition '${String(resolution.disposition)}' — failing closed`,
              runId: evidence.runId,
            };
            await evidence.saveResult(result);
            return result;
          }

          // Control returns to automation on the same session
          session.resumeAutomation();
          resolvedInterventions.push(intervention.id);
          await evidence.saveScreenshot(page, `resumed-after-${intervention.id.slice(0, 8)}`);
          await evidence.logStep({
            stepId: step.id,
            action: "intervention",
            description: `Human resolved (${disposition}): ${resolution?.notes ?? "no notes"}`,
            url: page.url(),
          });

          if (disposition === "performed_manually") {
            // The human executed this step in the live session; verify its
            // checkpoint if one exists, then continue with the next step.
            if (step.checkpoint) {
              const ok = await this.checkCheckpoint(page, step.checkpoint, opts.params);
              if (!ok) {
                const screenshot = await evidence.saveScreenshot(page, `failure-${step.id}`);
                const result: ReplayResult = {
                  status: "failure",
                  step: step.id,
                  failureClass: "checkpoint_mismatch",
                  expected: `Checkpoint after manual step: ${step.checkpoint.type}`,
                  observed: `Checkpoint failed on ${page.url()}`,
                  runId: evidence.runId,
                  evidence: { screenshot },
                };
                await evidence.saveResult(result);
                return result;
              }
            }
            stepsExecuted++;
            session.advanceStep();
            continue;
          }
          // disposition === "approved": fall through and execute the step
        }

        const stepStart = Date.now();
        try {
          const exec = await this.executeStep(page, step, opts.params, artifact);
          stepsExecuted++;
          session.advanceStep();

          if (exec.usedFallback) {
            driftWarnings.push({
              step: step.id,
              primaryStrategy: exec.primaryStrategy ?? "unknown",
              resolvedWith: exec.strategyUsed ?? "unknown",
            });
            console.warn(
              `⚠ Drift: step ${step.id} primary locator failed; resolved via fallback [${exec.strategyUsed}]. Flag artifact for review.`,
            );
          }

          await evidence.logStep({
            stepId: step.id,
            action: step.action,
            description: step.description,
            url: page.url(),
            durationMs: Date.now() - stepStart,
            locatorStrategyUsed: exec.strategyUsed,
            drift: exec.usedFallback || undefined,
          });

          // Check error handlers before step checkpoint — business outcomes
          // like "not found" should not be treated as checkpoint failures
          for (const handler of artifact.errorHandlers) {
            const detected = await this.detectCondition(page, handler.detect, artifact);
            if (detected) {
              const outcome = await this.handleErrorResponse(handler, evidence.runId, artifact, page, session, evidence);
              if (outcome) return outcome;
              // null → condition recovered (e.g. session dialog dismissed);
              // the run continues with the next step
            }
          }

          if (step.checkpoint) {
            const ok = await this.checkCheckpoint(page, step.checkpoint, opts.params);
            if (!ok) {
              const screenshot = await evidence.saveScreenshot(page, `failure-${step.id}`);
              const result: ReplayResult = {
                status: "failure",
                step: step.id,
                failureClass: "checkpoint_mismatch",
                expected: `Checkpoint: ${step.checkpoint.type}`,
                observed: `Checkpoint failed on ${page.url()}`,
                runId: evidence.runId,
                evidence: { screenshot },
              };
              await evidence.saveResult(result);
              return result;
            }
          }
        } catch (err) {
          const failureClass = classifyError(err);

          // Bounded assisted fallback: exactly one LLM call, only for a
          // locator miss, only when explicitly enabled. The step's recorded
          // intent (description + action + value) constrains what the model
          // may do; the result is recorded as evidence and the artifact is
          // flagged for re-review — never silently self-healed.
          if (failureClass === "locator_miss" && opts.assist) {
            const recovered = await this.attemptAssistedRecovery(
              adapter,
              page,
              step,
              opts.params,
              evidence,
            ).catch(async (recoveryErr) => {
              // An API/infra failure during recovery is evidence, not silence —
              // otherwise it is indistinguishable from the model declining.
              await evidence
                .logStep({
                  stepId: step.id,
                  action: "assisted_recovery_error",
                  description:
                    recoveryErr instanceof Error
                      ? recoveryErr.message
                      : String(recoveryErr),
                  url: page.url(),
                })
                .catch(() => {});
              return false;
            });
            if (recovered) {
              stepsExecuted++;
              session.advanceStep();
              assistedRecoveries.push(step.id);
              console.warn(
                `⚠ Assisted recovery: step ${step.id} re-resolved by one bounded LLM call. Artifact needs re-review.`,
              );
              if (step.checkpoint) {
                const ok = await this.checkCheckpoint(page, step.checkpoint, opts.params);
                if (!ok) {
                  const screenshot = await evidence.saveScreenshot(page, `failure-${step.id}`);
                  const result: ReplayResult = {
                    status: "failure",
                    step: step.id,
                    failureClass: "checkpoint_mismatch",
                    expected: `Checkpoint after assisted recovery: ${step.checkpoint.type}`,
                    observed: `Checkpoint failed on ${page.url()}`,
                    runId: evidence.runId,
                    evidence: { screenshot },
                  };
                  await evidence.saveResult(result);
                  return result;
                }
              }
              continue;
            }
          }

          const screenshot = await evidence.saveScreenshot(page, `error-${step.id}`);
          const result: ReplayResult = {
            status: "failure",
            step: step.id,
            failureClass,
            expected: step.description,
            observed: err instanceof Error ? err.message : String(err),
            runId: evidence.runId,
            evidence: { screenshot },
          };
          await evidence.saveResult(result);
          return result;
        }
      }

      // Verify success checkpoint
      const successOk = await this.checkCheckpoint(page, artifact.successCheckpoint, opts.params);
      if (!successOk) {
        const screenshot = await evidence.saveScreenshot(page, "success-checkpoint-failed");
        const result: ReplayResult = {
          status: "failure",
          step: "successCheckpoint",
          failureClass: "checkpoint_mismatch",
          expected: artifact.successCheckpoint.type,
          observed: "Success checkpoint not met",
          runId: evidence.runId,
          evidence: { screenshot },
        };
        await evidence.saveResult(result);
        return result;
      }

      const finalPageText = await page.locator("body").innerText();
      for (const [key, def] of Object.entries(artifact.outputs)) {
        outputs[key] = this.extractOutput(finalPageText, key, def);
      }

      const result: ReplayResult = {
        status: "success",
        outputs,
        runId: evidence.runId,
        durationMs: Date.now() - startMs,
        stepsExecuted,
        interventions: resolvedInterventions.length ? resolvedInterventions : undefined,
        driftWarnings: driftWarnings.length ? driftWarnings : undefined,
        assistedRecoveries: assistedRecoveries.length ? assistedRecoveries : undefined,
      };

      // Persisted evidence redacts sensitive outputs; the caller still
      // receives the full result object.
      await evidence.saveResult({
        ...result,
        outputs: redactSensitive(outputs, sensitiveKeys),
      });
      await evidence.finalize({ success: true });
      session.complete();
      return result;
    } catch (err) {
      // A guardrail that blocks an action but records nothing is itself an
      // audit failure. Any exception that escapes the per-step handling
      // (entry policy check, navigation failure, invalid parameters on a
      // gated step, evidence I/O) still produces a structured, classified
      // result and a screenshot — never a bare crash.
      session.fail();
      const failureClass = classifyError(err);
      let screenshot: string | undefined;
      try {
        screenshot = await evidence.saveScreenshot(page, "unhandled-error");
      } catch {
        // page may already be unusable
      }
      const result: ReplayResult = {
        status: "failure",
        step: "run",
        failureClass,
        expected: "Run completes or ends with a structured result",
        observed: err instanceof Error ? err.message : String(err),
        runId: evidence.runId,
        evidence: screenshot ? { screenshot } : undefined,
      };
      try {
        await evidence.logStep({
          action: "unhandled_error",
          description: result.observed,
          error: failureClass,
        });
        await evidence.saveResult(result);
      } catch {
        // evidence directory itself unwritable — nothing more we can record
      }
      return result;
    } finally {
      // Never let cleanup mask the run's real outcome: a browser that died
      // mid-run would make close() throw and replace the original error.
      try {
        await session.close();
      } catch {
        // browser/context already gone
      }
    }
  }

  /**
   * Contract + policy checks that require no browser. Returns null when the
   * invocation is valid.
   */
  private validateInputs(
    artifact: CapabilityArtifact,
    params: Record<string, unknown>,
  ): { failureClass: FailureClass; message: string } | null {
    for (const [name, def] of Object.entries(artifact.parameters)) {
      const value = params[name];
      if (value === undefined || value === null) {
        if (def.required) {
          return {
            failureClass: "invalid_input",
            message: `Missing required parameter: ${name}`,
          };
        }
        continue;
      }
      if (def.type === "number" && Number.isNaN(Number(value))) {
        return {
          failureClass: "invalid_input",
          message: `Parameter '${name}' must be a number, got: ${String(value)}`,
        };
      }
      if (
        def.type === "boolean" &&
        typeof value !== "boolean" &&
        !["true", "false"].includes(String(value))
      ) {
        return {
          failureClass: "invalid_input",
          message: `Parameter '${name}' must be a boolean, got: ${String(value)}`,
        };
      }
    }

    try {
      this.policy.assertStepBudget(artifact.steps.length);
    } catch (err) {
      return {
        failureClass: "policy_violation",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return null;
  }

  private async executeStep(
    page: import("playwright").Page,
    step: Step,
    params: Record<string, unknown>,
    artifact: CapabilityArtifact,
  ): Promise<StepExecution> {
    void artifact; // reserved for future frame-path context
    const value = step.value ? resolveStepValue(step.value, params) : undefined;

    const resolveTarget = async (): Promise<{
      locator: import("playwright").Locator;
      exec: StepExecution;
    }> => {
      const resolved = await resolveLocatorDetailed(page, step.target!);
      return {
        locator: resolved.locator,
        exec: {
          strategyUsed: describeStrategy(resolved.strategy),
          usedFallback: resolved.usedFallback,
          primaryStrategy: step.target!.strategies[0]
            ? describeStrategy(step.target!.strategies[0])
            : undefined,
        },
      };
    };

    switch (step.action) {
      case "navigate":
        this.policy.assertNavigationAllowed(value!);
        await page.goto(value!, { waitUntil: "domcontentloaded" });
        return {};
      case "click": {
        const { locator, exec } = await resolveTarget();
        await locator.click({ timeout: step.timeoutMs });
        return exec;
      }
      case "fill": {
        const { locator, exec } = await resolveTarget();
        await locator.fill(value ?? "", { timeout: step.timeoutMs });
        return exec;
      }
      case "select": {
        const { locator, exec } = await resolveTarget();
        await locator.selectOption(value ?? "", { timeout: step.timeoutMs });
        return exec;
      }
      case "press":
        await page.keyboard.press(value ?? "Enter");
        return {};
      case "wait": {
        const ms = parseInt(value ?? "1000", 10);
        await page.waitForTimeout(Number.isNaN(ms) ? 1000 : ms);
        return {};
      }
      default:
        throw new Error(`Replay does not support action: ${step.action}`);
    }
  }

  /**
   * Bounded assisted fallback. Exactly one LLM call constrained by the
   * step's recorded intent: the model may only pick a ref for THIS step's
   * action, or give up. The action still passes through the policy engine,
   * the new locator is captured as a healing candidate, and the whole
   * exchange is written to evidence. This is the middle ground between
   * "deterministic replay fails hard" (brittle) and "let the LLM improvise"
   * (unauditable).
   */
  private async attemptAssistedRecovery(
    adapter: PlaywrightSurfaceAdapter,
    page: import("playwright").Page,
    step: Step,
    params: Record<string, unknown>,
    evidence: EvidenceLogger,
  ): Promise<boolean> {
    if (!process.env.ANTHROPIC_API_KEY) return false;
    if (!["click", "fill", "select"].includes(step.action)) return false;

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.DISCOVERY_MODEL ?? "claude-sonnet-5";

    const observation = await adapter.observe();
    await evidence.saveSnapshot(observation.snapshot, `assist-${step.id}`);

    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system:
        "You are recovering a single failed step of a recorded UI automation. " +
        "You get the step's recorded intent and the current accessibility snapshot. " +
        "If one element clearly matches the intent, return its ref. If you are not " +
        "confident, give up — a wrong click in a banking app is worse than a failed run.",
      tools: [
        {
          name: "resolve_element",
          description: `Identify the element for this ${step.action} action`,
          input_schema: {
            type: "object",
            properties: {
              ref: { type: "string", description: "aria-ref from the snapshot, e.g. e6" },
              rationale: { type: "string" },
            },
            required: ["ref", "rationale"],
          },
        },
        {
          name: "give_up",
          description: "No element clearly matches the recorded intent",
          input_schema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      ],
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content:
            `Recorded step intent: ${step.description}\n` +
            `Action: ${step.action}\n` +
            `Original locator strategies (all failed): ${JSON.stringify(step.target?.strategies)}\n\n` +
            `Current page snapshot:\n${observation.snapshot}`,
        },
      ],
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse || toolUse.name === "give_up") {
      const reason = toolUse
        ? String((toolUse.input as Record<string, unknown>).reason)
        : "no tool call";
      await evidence.logStep({
        stepId: step.id,
        action: "assisted_recovery_declined",
        description: `LLM declined to recover: ${reason}`,
        url: page.url(),
      });
      return false;
    }

    const input = toolUse.input as Record<string, unknown>;
    const ref = String(input.ref);

    // Same guardrails as any other action — assist mode does not bypass policy
    this.policy.assertActionAllowed(step.action, page.url());

    // Capture the healed locator before acting (navigation invalidates refs)
    const healedTarget = await adapter.captureTargetFromRef(ref).catch(() => undefined);

    const value = step.value ? String(resolveStepValue(step.value, params)) : undefined;
    await adapter.execute({ action: step.action, ref, value });

    await evidence.logStep({
      stepId: step.id,
      action: "assisted_recovery",
      description: `LLM re-resolved '${step.description}' → ref ${ref}. Rationale: ${String(input.rationale)}`,
      url: page.url(),
    });
    if (healedTarget) {
      await evidence.saveArtifact(`healed-target-${step.id}.json`, healedTarget);
    }
    return true;
  }

  private async checkCheckpoint(
    page: import("playwright").Page,
    checkpoint: Checkpoint,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const timeout = checkpoint.timeoutMs ?? 10000;
    switch (checkpoint.type) {
      case "text_present":
        try {
          await page.getByText(checkpoint.value!, { exact: false }).waitFor({ timeout });
          return true;
        } catch {
          return false;
        }
      case "text_absent":
        return !(await page.getByText(checkpoint.value!, { exact: false }).isVisible().catch(() => false));
      case "url_matches":
        return checkpoint.value ? page.url().includes(checkpoint.value) : false;
      case "element_visible": {
        if (!checkpoint.target) return false;
        try {
          const locator = await resolveLocator(page, checkpoint.target);
          await locator.waitFor({ state: "visible", timeout });
          return true;
        } catch {
          return false;
        }
      }
      case "extract_match": {
        const text = await page.locator("body").innerText();
        if (checkpoint.pattern) {
          return new RegExp(checkpoint.pattern).test(text);
        }
        if (checkpoint.output && params[checkpoint.output]) {
          return text.includes(String(params[checkpoint.output]));
        }
        return false;
      }
      default:
        return true;
    }
  }

  private async detectCondition(
    page: import("playwright").Page,
    detect: { type: string; value: string },
    _artifact: CapabilityArtifact,
  ): Promise<boolean> {
    switch (detect.type) {
      case "text_present":
        return page.getByText(detect.value, { exact: false }).isVisible().catch(() => false);
      case "text_absent":
        return !(await page.getByText(detect.value, { exact: false }).isVisible().catch(() => false));
      case "url_matches":
        return page.url().includes(detect.value);
      case "dialog_present":
        return page.getByText(detect.value, { exact: false }).isVisible().catch(() => false);
      default:
        return false;
    }
  }

  /**
   * Handle a detected error condition. Returns a terminal ReplayResult, or
   * null when the condition was successfully recovered — in that case the
   * caller resumes the run. "Recovered" must mean the run continues toward
   * the goal, not that the run ends with a friendlier status.
   */
  private async handleErrorResponse(
    handler: CapabilityArtifact["errorHandlers"][number],
    runId: string,
    _artifact: CapabilityArtifact,
    page: import("playwright").Page,
    session: SessionManager,
    evidence: EvidenceLogger,
  ): Promise<ReplayResult | null> {
    const { response } = handler;

    if (response.kind === "business_outcome") {
      const result: ReplayResult = {
        status: "business_outcome",
        code: response.code ?? handler.id,
        message: response.message ?? handler.id,
        step: handler.id,
        runId,
      };
      await evidence.saveResult(result);
      return result;
    }

    if (response.kind === "recoverable" && response.recoveryAction) {
      try {
        if (response.recoveryAction.action === "click" && response.recoveryAction.value) {
          await page.getByText(response.recoveryAction.value).click();
        }
        await evidence.logStep({
          action: "recovered",
          description: `Recovered from '${handler.id}' via ${response.recoveryAction.action}; run continues`,
          url: page.url(),
        });
        session.resumeAutomation();
        return null;
      } catch {
        const result: ReplayResult = {
          status: "recoverable",
          condition: handler.id,
          action: "recovery_failed",
          recovered: false,
          runId,
        };
        await evidence.saveResult(result);
        return result;
      }
    }

    const observation = await page.locator("body").ariaSnapshot();
    const intervention = await this.hitl.requestIntervention(session, page, {
      reason: response.message ?? handler.id,
      snapshot: observation,
    });
    const result: ReplayResult = {
      status: "escalated",
      interventionId: intervention.id,
      reason: response.message ?? handler.id,
      runId,
    };
    await evidence.saveResult(result);
    return result;
  }

  private extractOutput(
    pageText: string,
    key: string,
    def: CapabilityArtifact["outputs"][string],
  ): unknown {
    // Primary: label-anchored pattern recorded in the artifact
    if (def.extract?.pattern) {
      const match = pageText.match(new RegExp(def.extract.pattern));
      if (match?.[1]) {
        const raw = match[1].trim();
        if (def.type === "number") {
          const num = parseFloat(raw.replace(/[$,]/g, ""));
          return Number.isNaN(num) ? raw : num;
        }
        return raw;
      }
    }

    // No extraction pattern, or the pattern didn't match: return null rather
    // than guess. Heuristics like "first $X.XX on the page" silently return
    // the WRONG value when a page shows multiple amounts — for financial data,
    // no answer beats a plausible wrong one.
    return null;
  }
}
