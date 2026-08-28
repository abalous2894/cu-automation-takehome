import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";

export interface RunContext {
  runId: string;
  mode: "discovery" | "replay" | "agent";
  goal?: string;
  capabilityId?: string;
  startedAt: string;
  initiatedBy: "agent" | "operator" | "cli";
}

export interface StepLogEntry {
  index: number;
  stepId?: string;
  action: string;
  description?: string;
  url?: string;
  timestamp: string;
  durationMs?: number;
  locatorStrategyUsed?: string;
  drift?: boolean;
  error?: string;
  /**
   * Tamper-evidence: each entry carries the SHA-256 of the previous entry.
   * Editing or deleting any historical entry breaks the chain — the property
   * auditors check first for automated actions against regulated data.
   */
  prevHash?: string;
  hash?: string;
}

export class EvidenceLogger {
  private runContext: RunContext;
  private stepIndex = 0;
  private outputDir: string;
  private steps: StepLogEntry[] = [];
  private lastHash = "genesis";

  constructor(
    mode: RunContext["mode"],
    outputDir: string,
    opts: Partial<Pick<RunContext, "goal" | "capabilityId" | "initiatedBy">> = {},
  ) {
    this.outputDir = outputDir;
    this.runContext = {
      runId: uuidv4(),
      mode,
      startedAt: new Date().toISOString(),
      initiatedBy: opts.initiatedBy ?? "cli",
      goal: opts.goal,
      capabilityId: opts.capabilityId,
    };
  }

  get runId(): string {
    return this.runContext.runId;
  }

  async init(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(join(this.outputDir, "screenshots"), { recursive: true });
    await writeFile(
      join(this.outputDir, "run.json"),
      JSON.stringify({ ...this.runContext, steps: [] }, null, 2),
    );
  }

  async logStep(
    entry: Omit<StepLogEntry, "index" | "timestamp" | "prevHash" | "hash">,
  ): Promise<void> {
    const record: StepLogEntry = {
      ...entry,
      index: this.stepIndex++,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash,
    };
    record.hash = createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");
    this.lastHash = record.hash;

    this.steps.push(record);
    await appendFile(
      join(this.outputDir, "steps.jsonl"),
      JSON.stringify(record) + "\n",
    );
    await this.flushRunJson();
  }

  /**
   * Verify the hash chain of a steps.jsonl file. Returns the first broken
   * index or -1. Chains are per-run: a steps.jsonl that accumulated multiple
   * runs contains one segment per run, each anchored at "genesis". Tampering
   * or deletion within a segment breaks it; cross-run ordering is established
   * by run.json timestamps, not the chain.
   */
  static verifyChain(entries: StepLogEntry[]): number {
    let prev = "genesis";
    for (let i = 0; i < entries.length; i++) {
      const { hash, ...rest } = entries[i];
      if (i > 0 && rest.prevHash === "genesis") {
        prev = "genesis"; // new run segment starts
      }
      if (rest.prevHash !== prev) return i;
      const expected = createHash("sha256")
        .update(JSON.stringify(rest))
        .digest("hex");
      if (hash !== expected) return i;
      prev = hash;
    }
    return -1;
  }

  async saveScreenshot(page: import("playwright").Page, name: string): Promise<string> {
    const filename = `${name}.png`;
    const filepath = join(this.outputDir, "screenshots", filename);
    await page.screenshot({ path: filepath, fullPage: true });
    return filepath;
  }

  async saveSnapshot(content: string, name: string): Promise<string> {
    const filename = `${name}.yaml`;
    const filepath = join(this.outputDir, "snapshots", name);
    await mkdir(join(this.outputDir, "snapshots"), { recursive: true });
    await writeFile(filepath.replace(/[^/]+$/, "") + filename, content);
    return join(this.outputDir, "snapshots", filename);
  }

  async saveArtifact(filename: string, data: unknown): Promise<string> {
    const filepath = join(this.outputDir, filename);
    await writeFile(filepath, JSON.stringify(data, null, 2));
    return filepath;
  }

  async saveResult(result: unknown): Promise<void> {
    await writeFile(
      join(this.outputDir, "result.json"),
      JSON.stringify(result, null, 2),
    );
    await this.flushRunJson({ result });
  }

  async finalize(meta: Record<string, unknown> = {}): Promise<void> {
    await this.flushRunJson({ ...meta, completedAt: new Date().toISOString() });
  }

  private async flushRunJson(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      join(this.outputDir, "run.json"),
      JSON.stringify(
        { ...this.runContext, steps: this.steps, ...extra },
        null,
        2,
      ),
    );
  }
}

export function redactSensitive(
  data: Record<string, unknown>,
  sensitiveKeys: Set<string>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] = sensitiveKeys.has(key) ? "[REDACTED]" : value;
  }
  return redacted;
}
