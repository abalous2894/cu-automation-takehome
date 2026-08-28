#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import express from "express";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HitlController,
  isValidDisposition,
  type InterventionDisposition,
} from "../hitl/controller.js";

/**
 * Everything rendered in the console originates from artifacts, page content,
 * or operator input — all untrusted. The surface being automated must not be
 * able to script the browser of the human holding approval authority.
 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const program = new Command();

program
  .name("operator")
  .description("Minimal operator console for human-in-the-loop interventions")
  .requiredOption("--intervention <id>", "Intervention ID to review")
  .option("--port <n>", "Port for operator UI", "4000")
  .option(
    "--resolve <disposition>",
    "Resolve non-interactively: approved | performed_manually | abort",
  )
  .option("--notes <text>", "Operator notes for non-interactive resolution")
  .option("--as <operator>", "Operator identity for the audit record", "operator")
  .action(async (opts) => {
    const dir = join("./evidence/interventions", opts.intervention);
    const request = JSON.parse(
      await readFile(join(dir, "request.json"), "utf-8"),
    );
    const hitl = new HitlController();

    // Non-interactive mode: resolve immediately (useful for demos and CI)
    if (opts.resolve) {
      const disposition = opts.resolve as InterventionDisposition;
      if (!isValidDisposition(disposition)) {
        console.error(`Invalid disposition: ${disposition}`);
        process.exit(1);
      }
      await hitl.resolveIntervention(opts.intervention, disposition, opts.notes, opts.as);
      console.log(`Intervention ${opts.intervention} resolved: ${disposition} (by ${opts.as})`);
      process.exit(0);
    }

    const app = express();
    app.use("/evidence", express.static(dir));
    app.use(express.json());

    app.get("/", (_req, res) => {
      res.send(`<!DOCTYPE html>
<html>
<head><title>Operator Console — Intervention</title>
<style>
  body { font-family: system-ui; max-width: 900px; margin: 40px auto; padding: 0 20px; }
  .context { background: #f5f5f5; padding: 16px; border-radius: 8px; margin-bottom: 20px; }
  img { max-width: 100%; border: 1px solid #ccc; }
  .actions { display: flex; gap: 12px; margin: 16px 0; }
  button { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; color: white; }
  .approve { background: #1a7f37; }
  .manual { background: #000080; }
  .abort { background: #b91c1c; }
  textarea { width: 100%; height: 80px; margin: 12px 0; }
</style>
</head>
<body>
  <h1>Operator Console</h1>
  <div class="context">
    <p><strong>Intervention:</strong> ${esc(opts.intervention)}</p>
    <p><strong>Session:</strong> ${esc(request.sessionId)}</p>
    <p><strong>Reason:</strong> ${esc(request.reason)}</p>
    ${request.goal ? `<p><strong>Goal:</strong> ${esc(request.goal)}</p>` : ""}
    ${request.capabilityId ? `<p><strong>Capability:</strong> ${esc(request.capabilityId)}</p>` : ""}
    ${request.currentStep ? `<p><strong>Blocked Step:</strong> ${esc(request.currentStep)}</p>` : ""}
  </div>
  ${
    request.proposedAction
      ? `<h2>Proposed Action (awaiting your decision)</h2>
  <div class="context" style="border-left: 4px solid #b91c1c;">
    <p><strong>Action:</strong> ${esc(request.proposedAction.action)}</p>
    ${request.proposedAction.targetDescription ? `<p><strong>Target:</strong> ${esc(request.proposedAction.targetDescription)}</p>` : ""}
    ${request.proposedAction.resolvedValue ? `<p><strong>Value:</strong> ${esc(request.proposedAction.resolvedValue)}</p>` : ""}
    ${request.proposedAction.riskLevel ? `<p><strong>Risk:</strong> ${esc(request.proposedAction.riskLevel)}</p>` : ""}
  </div>`
      : ""
  }
  <h2>Live Session State</h2>
  <p>The automation is paused and holding the browser session open. If running headed, you can act in that window directly.</p>
  <img src="/evidence/screenshot.png" alt="Current browser state">
  <h2>Resolve</h2>
  <textarea id="notes" placeholder="Operator notes (what you did / why)"></textarea>
  <div class="actions">
    <button class="approve" onclick="resolve('approved')">Approve — let automation execute the step</button>
    <button class="manual" onclick="resolve('performed_manually')">I performed it manually — skip the step</button>
    <button class="abort" onclick="resolve('abort')">Abort the run</button>
  </div>
  <p id="status"></p>
  <script>
    async function resolve(disposition) {
      const notes = document.getElementById('notes').value;
      const res = await fetch('/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disposition, notes })
      });
      const data = await res.json();
      document.getElementById('status').textContent = data.message;
    }
  </script>
</body>
</html>`);
    });

    app.post("/resolve", async (req, res) => {
      const { disposition, notes } = req.body as {
        disposition: unknown;
        notes?: string;
      };
      // Fail closed: reject rather than record an unrecognized disposition
      if (!isValidDisposition(disposition)) {
        res.status(400).json({ message: `Invalid disposition: ${String(disposition)}` });
        return;
      }
      await hitl.resolveIntervention(opts.intervention, disposition, notes, opts.as);
      res.json({ message: `Resolved: ${disposition}. Automation will resume.` });
      console.log(`Intervention ${opts.intervention} resolved: ${disposition}`);
      setTimeout(() => process.exit(0), 1000);
    });

    // Loopback only — approval authority must not be reachable from the LAN
    app.listen(parseInt(opts.port, 10), "127.0.0.1", () => {
      console.log(`Operator console: http://localhost:${opts.port}`);
      console.log(`Reviewing intervention: ${opts.intervention}`);
      console.log(`Reason: ${request.reason}`);
    });
  });

program.parse();
