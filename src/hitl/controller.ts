import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { SessionManager } from "../session/manager.js";

/**
 * The exact action awaiting approval, with parameters already resolved —
 * the reviewer sees precisely what will be executed, not a paraphrase.
 * (Propose-then-commit: the agent proposes; only the approved payload runs.)
 */
export interface ProposedAction {
  action: string;
  targetDescription?: string;
  resolvedValue?: string;
  riskLevel?: string;
}

export interface InterventionRequest {
  id: string;
  sessionId: string;
  reason: string;
  goal?: string;
  capabilityId?: string;
  currentStep?: string;
  currentStepIndex?: number;
  proposedAction?: ProposedAction;
  screenshotPath?: string;
  snapshotPath?: string;
  createdAt: string;
  status: "pending" | "resolved";
}

/**
 * How the human resolved the intervention:
 * - approved: automation may execute the gated step itself
 * - performed_manually: the human did the step in the live session; skip it
 * - abort: stop the run
 */
export type InterventionDisposition = "approved" | "performed_manually" | "abort";

export const VALID_DISPOSITIONS: readonly InterventionDisposition[] = [
  "approved",
  "performed_manually",
  "abort",
] as const;

export function isValidDisposition(
  value: unknown,
): value is InterventionDisposition {
  return VALID_DISPOSITIONS.includes(value as InterventionDisposition);
}

export interface InterventionResolution {
  disposition: InterventionDisposition;
  notes?: string;
  resolvedAt: string;
  resolvedBy: string;
}

export class HitlController {
  constructor(private evidenceRoot = "./evidence/interventions") {}

  async requestIntervention(
    session: SessionManager,
    page: Page,
    opts: {
      reason: string;
      goal?: string;
      capabilityId?: string;
      currentStep?: string;
      proposedAction?: ProposedAction;
      snapshot?: string;
    },
  ): Promise<InterventionRequest> {
    session.pauseForHuman();

    const id = crypto.randomUUID();
    const dir = join(this.evidenceRoot, id);
    await mkdir(dir, { recursive: true });

    const screenshotPath = join(dir, "screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    let snapshotPath: string | undefined;
    if (opts.snapshot) {
      snapshotPath = join(dir, "snapshot.yaml");
      await writeFile(snapshotPath, opts.snapshot);
    }

    const request: InterventionRequest = {
      id,
      sessionId: session.sessionId,
      reason: opts.reason,
      goal: opts.goal,
      capabilityId: opts.capabilityId,
      currentStep: opts.currentStep,
      currentStepIndex: session.info.currentStepIndex,
      proposedAction: opts.proposedAction,
      screenshotPath,
      snapshotPath,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    await writeFile(join(dir, "request.json"), JSON.stringify(request, null, 2));
    return request;
  }

  /**
   * Block until the operator writes resolution.json for this intervention,
   * polling the filesystem. The browser session stays open while waiting —
   * this is what makes the handoff real: the human operates the same live
   * session, then signals resume through the operator console.
   *
   * Returns null on timeout (run should surface an escalated result).
   */
  async awaitResolution(
    interventionId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<InterventionResolution | null> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const resolutionPath = join(this.evidenceRoot, interventionId, "resolution.json");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const raw = await readFile(resolutionPath, "utf-8");
        return JSON.parse(raw) as InterventionResolution;
      } catch {
        // not resolved yet
      }
      await sleep(pollIntervalMs);
    }

    // Close out the lifecycle on timeout: mark the request timed_out so the
    // audit trail links the abandoned run to the intervention, and so a late
    // operator resolution is visibly writing to an already-closed request.
    try {
      const requestPath = join(this.evidenceRoot, interventionId, "request.json");
      const request = JSON.parse(await readFile(requestPath, "utf-8"));
      if (request.status === "pending") {
        request.status = "timed_out";
        request.timedOutAt = new Date().toISOString();
        await writeFile(requestPath, JSON.stringify(request, null, 2));
      }
    } catch {
      // request.json missing or unreadable — timeout is still surfaced via the run result
    }
    return null;
  }

  async resolveIntervention(
    interventionId: string,
    disposition: InterventionDisposition,
    notes?: string,
    resolvedBy = "operator",
  ): Promise<InterventionResolution> {
    // Fail closed: an approval record with an unrecognized disposition must
    // never be writable, regardless of which caller (CLI, HTTP) forgot to
    // validate.
    if (!isValidDisposition(disposition)) {
      throw new Error(
        `Invalid disposition '${String(disposition)}'. Must be one of: ${VALID_DISPOSITIONS.join(", ")}`,
      );
    }
    const resolution: InterventionResolution = {
      disposition,
      notes,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
    };
    const dir = join(this.evidenceRoot, interventionId);
    await writeFile(
      join(dir, "resolution.json"),
      JSON.stringify(resolution, null, 2),
    );
    // Close out the request record so the intervention lifecycle is auditable
    // end-to-end (pending → resolved), not just via the resolution file.
    try {
      const requestPath = join(dir, "request.json");
      const request = JSON.parse(await readFile(requestPath, "utf-8"));
      request.status = "resolved";
      await writeFile(requestPath, JSON.stringify(request, null, 2));
    } catch {
      // request.json missing or unreadable — resolution.json remains the record
    }
    return resolution;
  }
}
