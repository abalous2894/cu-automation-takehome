#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DiscoveryAgent } from "../discovery/agent.js";

const program = new Command();

program
  .name("discover")
  .description("Run LLM-driven discovery against a live surface")
  .requiredOption("--goal <goal>", "Natural language goal")
  .requiredOption("--target <url>", "Target application URL")
  .option(
    "--params <json>",
    "Test values for input parameters, e.g. '{\"memberId\":\"12345\"}'. Recorded values matching these are parameterized in the artifact.",
  )
  .option("--output <dir>", "Evidence output directory", "./evidence/discovery")
  .option("--max-steps <n>", "Maximum agent steps", "25")
  .option("--headed", "Run browser in headed mode")
  .action(async (opts) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Error: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
      process.exit(1);
    }

    await mkdir(opts.output, { recursive: true });

    console.log("Starting discovery run...");
    console.log(`  Goal:   ${opts.goal}`);
    console.log(`  Target: ${opts.target}`);
    console.log(`  Output: ${opts.output}`);

    const agent = new DiscoveryAgent();
    const result = await agent.run({
      goal: opts.goal,
      targetUrl: opts.target,
      outputDir: opts.output,
      params: opts.params ? JSON.parse(opts.params) : undefined,
      maxSteps: parseInt(opts.maxSteps, 10),
      headless: !opts.headed,
    });

    console.log("\nDiscovery complete:");
    console.log(`  Run ID:    ${result.runId}`);
    console.log(`  Success:   ${result.success}`);
    console.log(`  Steps:     ${result.stepsRecorded}`);

    if (result.artifact) {
      console.log(`  Artifact:  ${join(opts.output, "capability.json")}`);
      console.log(`  ID:        ${result.artifact.id}`);
    }
    if (result.outputs) {
      console.log(`  Outputs:   ${JSON.stringify(result.outputs)}`);
    }
    if (result.escalated) {
      console.log(`  Escalated: ${result.interventionId}`);
    }

    process.exit(result.success ? 0 : 1);
  });

program.parse();
