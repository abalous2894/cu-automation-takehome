/**
 * Verify the hash chain of an evidence steps.jsonl file.
 * Usage: npx tsx scripts/verify-chain.ts <path/to/steps.jsonl>
 */
import { readFile } from "node:fs/promises";
import { EvidenceLogger, type StepLogEntry } from "../src/evidence/logger.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npx tsx scripts/verify-chain.ts <steps.jsonl>");
  process.exit(2);
}

const raw = await readFile(path, "utf-8");
const entries: StepLogEntry[] = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// Older runs predate hash chaining; verify only the chained suffix
const chained = entries.filter((e) => e.hash);
const broken = EvidenceLogger.verifyChain(chained);

if (broken === -1) {
  console.log(`✓ Chain intact: ${chained.length} entries verified (${entries.length - chained.length} pre-chain entries skipped)`);
  process.exit(0);
} else {
  console.error(`✗ Chain BROKEN at entry ${broken}: ${JSON.stringify(chained[broken])}`);
  process.exit(1);
}
