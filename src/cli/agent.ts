#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ReplayEngine } from "../replay/engine.js";
import {
  CapabilityArtifactSchema,
  artifactToToolDefinition,
} from "../schema/capability.js";
import { redactSensitive } from "../evidence/logger.js";

const CAPABILITIES_DIR = "./artifacts";

async function loadCapabilities(): Promise<
  Array<{ artifact: ReturnType<typeof CapabilityArtifactSchema.parse>; path: string }>
> {
  const files = await readdir(CAPABILITIES_DIR).catch(() => []);
  const capabilities = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(CAPABILITIES_DIR, file), "utf-8");
    capabilities.push({
      artifact: CapabilityArtifactSchema.parse(JSON.parse(raw)),
      path: join(CAPABILITIES_DIR, file),
    });
  }
  return capabilities;
}

const program = new Command();

program
  .name("agent")
  .description("Top-level agent that discovers and invokes saved capabilities")
  .requiredOption("--ask <question>", "Natural language question")
  .option("--headed", "Run browser in headed mode")
  .action(async (opts) => {
    const capabilities = await loadCapabilities();

    if (capabilities.length === 0) {
      console.error(
        "No capabilities found in ./artifacts/. Run discover first and copy capability.json there.",
      );
      process.exit(1);
    }

    const tools = capabilities.map(({ artifact }) => ({
      name: artifactToToolDefinition(artifact).name,
      description: artifact.description,
      input_schema: artifactToToolDefinition(artifact).input_schema,
    }));

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: process.env.DISCOVERY_MODEL ?? "claude-sonnet-5",
      max_tokens: 1024,
      system: `You are a banking AI agent. You have access to automation capabilities for the Meridian CU Core system. 
Select the appropriate capability and provide the required parameters. 
If no capability matches, say so.`,
      tools,
      messages: [{ role: "user", content: opts.ask }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      const text = response.content.find((b) => b.type === "text");
      console.log(text && "text" in text ? text.text : "No capability matched.");
      process.exit(0);
    }

    const matched = capabilities.find(
      ({ artifact }) =>
        artifactToToolDefinition(artifact).name === toolUse.name,
    );
    if (!matched) {
      console.error("Capability not found for tool:", toolUse.name);
      process.exit(1);
    }

    console.log(`Invoking capability: ${matched.artifact.id}`);
    console.log(`Parameters: ${JSON.stringify(toolUse.input)}`);

    const engine = new ReplayEngine();
    const result = await engine.run({
      capability: matched.path,
      params: toolUse.input as Record<string, unknown>,
      outputDir: "./evidence/agent",
      headless: !opts.headed,
    });

    // Console output is a log surface too — redact sensitive outputs
    const printable =
      result.status === "success"
        ? {
            ...result,
            outputs: redactSensitive(
              result.outputs,
              new Set(
                Object.entries(matched.artifact.outputs)
                  .filter(([, def]) => def.sensitive)
                  .map(([key]) => key),
              ),
            ),
          }
        : result;
    console.log("\nResult:", JSON.stringify(printable, null, 2));
    process.exit(result.status === "success" ? 0 : 1);
  });

program.parse();
