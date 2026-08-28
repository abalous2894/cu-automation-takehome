#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { ReplayEngine } from "../replay/engine.js";

const program = new Command();

program
  .name("replay")
  .description("Deterministic replay of a saved capability artifact")
  .requiredOption("--capability <path>", "Path to capability.json")
  .requiredOption("--params <json>", "Input parameters as JSON string")
  .option("--output <dir>", "Evidence output directory", "./evidence/replay")
  .option("--times <n>", "Run N times and report stability", "1")
  .option("--headed", "Run browser in headed mode")
  .option(
    "--assist",
    "On locator miss, allow one bounded LLM call to recover the step (recorded as evidence)",
  )
  .action(async (opts) => {
    const params = JSON.parse(opts.params) as Record<string, unknown>;
    const times = parseInt(opts.times, 10);
    const engine = new ReplayEngine();

    const results = [];

    for (let i = 0; i < times; i++) {
      const outputDir =
        times > 1 ? `${opts.output}/run-${i + 1}` : opts.output;
      await mkdir(outputDir, { recursive: true });

      console.log(`Replay run ${i + 1}/${times}...`);
      const result = await engine.run({
        capability: opts.capability,
        params,
        outputDir,
        headless: !opts.headed,
        assist: Boolean(opts.assist),
      });
      results.push(result);
      console.log(`  Status: ${result.status}`);
      if (result.status === "success") {
        console.log(`  Outputs: ${JSON.stringify(result.outputs)}`);
        console.log(`  Duration: ${result.durationMs}ms`);
        if (result.driftWarnings?.length) {
          console.log(
            `  ⚠ Drift detected on ${result.driftWarnings.length} step(s) — artifact should be reviewed`,
          );
        }
        if (result.assistedRecoveries?.length) {
          console.log(
            `  ⚠ Assisted recovery used on: ${result.assistedRecoveries.join(", ")} — artifact needs re-review`,
          );
        }
      } else if (result.status === "business_outcome") {
        console.log(`  Code: ${result.code} — ${result.message}`);
      } else if (result.status === "failure") {
        console.log(
          `  Failed at step ${result.step} [${result.failureClass}]: ${result.observed}`,
        );
      }
    }

    if (times > 1) {
      const passed = results.filter((r) => r.status === "success").length;
      console.log(`\nStability: ${passed}/${times} passed`);
    }

    // Success and business outcomes are both completed runs; exit non-zero
    // if ANY run failed (a 9/10 stability check must not exit 0).
    const allCompleted = results.every(
      (r) => r.status === "success" || r.status === "business_outcome",
    );
    process.exit(allCompleted ? 0 : 1);
  });

program.parse();
