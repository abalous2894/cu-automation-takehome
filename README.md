# Computer-Use Automation System

**An LLM figures out a legacy banking workflow once; production replays it forever without a model.**

Give the system a natural-language goal ("look up a member's savings balance"). A discovery agent drives the real UI via its accessibility tree, and the run is recorded as a **typed, parameterized capability artifact** — a contract with declared inputs, outputs, checkpoints, and error handlers. Replay executes that artifact deterministically: no LLM, ~50× faster (~19s discovery → ~350ms replay), with policy guardrails, tamper-evident audit logs, human escalation on irreversible steps, and drift telemetry that flags UI changes before they break anything.

- **Design write-up:** [`REPORT.md`](REPORT.md) — architecture, error taxonomy, safety model, trade-offs
- **Proof:** [`EVIDENCE.md`](EVIDENCE.md) — every claim mapped to a real run artifact in `/evidence/`
- **Decision log:** [`decisions.md`](decisions.md) — one-line rationale per design choice, including how AI-assisted development was directed

## Architecture

```
Goal (natural language)
   │
   ▼
DiscoveryAgent (LLM loop) ──── observe → decide → act ──── records
   │                                                          │
   ▼                                                          ▼
SurfaceAdapter (Playwright / a11y tree)          CapabilityArtifact (typed, versioned)
   ▲                                                          │
   │                                                          ▼
ReplayEngine (deterministic, no LLM) ◄────────── invoked by agent or CLI
   │
   ├── PolicyEngine      allowlists, risk gating
   ├── HitlController    pause → human approves in same session → resume
   └── EvidenceLogger    hash-chained steps.jsonl, screenshots, redaction
```

## Prerequisites

- Node.js 20+
- Anthropic API key (for `discover` and `agent` commands)

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # add ANTHROPIC_API_KEY
```

## Demo Path

**Terminal 1 — start the mock banking app:**

```bash
npm run mock-app
# → http://localhost:3000
```

**Terminal 2 — discovery (real LLM run):**

```bash
npm run discover -- \
  --goal "Look up a member by their member ID and read their savings balance" \
  --params '{"memberId":"12345"}' \
  --target http://localhost:3000/search \
  --headed
```

This produces `./evidence/discovery/capability.json` and step logs. The `--params` values are typed by the agent during discovery, then canonicalized into `$param` references in the artifact so it replays with any member ID.

**Replay success:**

```bash
npm run replay -- \
  --capability ./evidence/discovery/capability.json \
  --params '{"memberId":"12345"}'
```

**Replay with a different member (parameterization proof):**

```bash
npm run replay -- \
  --capability ./evidence/discovery/capability.json \
  --params '{"memberId":"67890"}'
```

**Replay business outcome (member not found — a result, not a crash):**

```bash
npm run replay -- \
  --capability ./evidence/discovery/capability.json \
  --params '{"memberId":"99999"}'
```

**Escalation demo (irreversible step pauses for a human):**

```bash
# Terminal A — pauses at the final submit, prints the intervention ID
npm run replay -- \
  --capability ./artifacts/open_subaccount.json \
  --params '{"memberId":"12345","accountType":"savings"}'

# Terminal B — review and resolve (web console)
npm run operator -- --intervention <id>
# or non-interactive, with operator attribution for the audit record:
npm run operator -- --intervention <id> --resolve approved --notes "Verified details" --as jane.ops
```

**Drift detection (UI changed, fallback locator saves the run):**

```bash
# artifacts/demo/drifted_ui.json has a broken primary locator; replay succeeds
# via the fallback strategy and flags the artifact for review
npm run replay -- \
  --capability ./artifacts/demo/drifted_ui.json \
  --params '{"memberId":"12345"}'
# → success + "⚠ Drift detected on 1 step(s)"
```

**Bounded LLM recovery (all locators dead, one policy-checked LLM call):**

```bash
# artifacts/demo/broken_locator.json has no working locator for the Search button
npm run replay -- \
  --capability ./artifacts/demo/broken_locator.json \
  --params '{"memberId":"12345"}'
# → failure [locator_miss]

npm run replay -- \
  --capability ./artifacts/demo/broken_locator.json \
  --params '{"memberId":"12345"}' \
  --assist
# → success + assisted_recovery evidence + healed-target-step_2.json healing candidate
```

**Agent invokes a saved capability:**

```bash
cp evidence/discovery/capability.json artifacts/
npm run agent -- --ask "What's the savings balance for member 12345?"
```

**Human escalation operator console:**

```bash
npm run operator -- --intervention <intervention-id>
```

**Multi-run stability:**

```bash
npm run replay -- \
  --capability ./evidence/discovery/capability.json \
  --params '{"memberId":"12345"}' \
  --times 10
```

## Mock App

Local legacy-style credit union back-office (`mock-app/`):

| URL | Description |
|-----|-------------|
| `/search` | Member search (table layout, no test IDs) |
| `/member?id=12345` | Account detail with balances |
| `/member?id=99999` | "No member found" business outcome |
| `/frameset` | Legacy frameset navigation demo |
| `/tenant-a/search` | Tenant A — same labels as base, different branding/URL (base artifact replays as-is) |
| `/tenant-b/search` | Tenant B — renamed fields ("Account Number"), the case needing a label overlay |
| `/subaccount?memberId=12345` | Mutating flow (escalation demo) |

Test members: `12345`, `67890`, `11111`

## Project Structure

```
src/
  schema/capability.ts    # Artifact schema + replay result types (Zod)
  surface/                # SurfaceAdapter seam (Playwright implementation)
  discovery/agent.ts      # LLM observe→decide→act loop
  replay/engine.ts        # Deterministic replay (no LLM)
  policy/engine.ts        # Allowlist + risk gating
  hitl/controller.ts      # Human-in-the-loop pause/resume
  evidence/logger.ts      # Structured run logs + screenshots
  cli/                    # discover, replay, agent, operator commands
mock-app/                 # Legacy banking UI mock
evidence/                 # Run evidence (discovery + replay logs)
artifacts/                # Saved capabilities for agent catalog
REPORT.md                 # Design write-up
EVIDENCE.md               # Claim-by-claim index into /evidence
decisions.md              # Design decision log
```

## Tests

```bash
npm test
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required for discovery/agent |
| `MOCK_APP_PORT` | `3000` | Mock app port |
| `DISCOVERY_MODEL` | `claude-sonnet-5` | LLM for discovery and assisted recovery |
| `DISCOVERY_MAX_STEPS` | `25` | Max agent steps |
| `HEADLESS` | `true` | Browser headless mode |
