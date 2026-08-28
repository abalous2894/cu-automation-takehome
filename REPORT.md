# Design Write-up

## 1. Architecture

The system is a single-process TypeScript application with six modules connected by a shared **CapabilityArtifact** — the serializable contract between discovery, replay, and agent invocation.

```
CLI (discover | replay | agent | operator)
        │
   ┌────┴────┐
   ▼         ▼
Discovery   ReplayEngine          ← production path: no LLM
Agent (LLM) (deterministic)
   │         │
   └────┬────┘
        ▼
  CapabilityArtifact
        │
   SurfaceAdapter (Playwright)     ← heterogeneity seam
        │
   PolicyEngine + SessionManager + HitlController + EvidenceLogger
```

**Key decisions:**

- **Monolith over microservices.** Hundreds of tenants × ~20 apps means thousands of workers, not thousands of services. A replay worker loads an artifact, opens a browser, executes, returns a result. Queues and horizontal scaling attach at the worker boundary later; the artifact schema and replay contract are the load-bearing abstractions now.

- **Accessibility tree over vision.** Playwright's `ariaSnapshot({ mode: 'ai' })` gives the discovery LLM a compact YAML tree with stable `[ref=eN]` IDs for acting, while the artifact recorder captures semantic locators (role + name, label) that survive replay. Vision-based computer use (screenshot → coordinates) is more fragile on table-layout legacy UIs and costs 10–100× more per step.

- **Discovery and replay share a surface adapter but not a decision engine.** Discovery invokes Claude with tool calls (`click`, `fill`, `done`, `escalate`). Replay reads steps from the artifact and resolves locators deterministically. The LLM never runs in the production path.

- **Evidence is first-class.** Every run produces a UUID-scoped directory: structured `run.json`, append-only `steps.jsonl`, screenshots on failure, and the saved artifact. Step records are **hash-chained** (each entry carries the SHA-256 of the previous one, verifiable via `EvidenceLogger.verifyChain`), so editing or deleting any historical entry is detectable — the tamper-evidence property auditors check first for automated actions against member data. Interventions record **who** resolved them, not just how.

**Measured economics** (from the evidence in `/evidence/`): discovery costs ~12–19s wall clock and 3 LLM turns; deterministic replay of the same capability runs in ~280–360ms with zero LLM calls, and passed a 10/10 stability check. That gap is the argument for the record-once/replay-many architecture: the model reasons once, and production invocations are ~50× faster and free of inference cost.

## 2. Artifact schema

A capability artifact is an agent-invocable function definition, not a debug transcript.

| Field | Purpose |
|-------|---------|
| `parameters` | Typed inputs the calling agent supplies (`memberId: string`) |
| `outputs` | Typed data extracted and returned (`savingsBalance: number`) |
| `steps[]` | Ordered actions with multi-strategy element targets |
| `successCheckpoint` | Final assertion that the goal was actually reached |
| `errorHandlers[]` | Declarative detection + response for runtime conditions |
| `metadata.riskProfile` | `read_only` / `mutating` / `irreversible` — gates unattended replay |

**Locator design:** Each step target carries an ordered `strategies[]` array. Replay tries role+name first, then label, then placeholder, then structural xpath — stopping at the first strategy that resolves to exactly one element. During discovery, ephemeral `aria-ref` IDs drive the LLM; the recorder captures semantic strategies at action time so replay never depends on snapshot-specific refs.

**Parameterization:** During discovery the agent types real test values (supplied via `--params`); the recorder then canonicalizes any recorded value matching a test parameter into a `{ "$param": "memberId" }` reference — and scrubs the same values from free-text step descriptions ("Enter member ID `<memberId>`"), since a test value surviving in prose would defeat what value-level parameterization claims. This keeps artifacts reusable across inputs and prevents PII from being baked into the capability definition. The evidence includes the same artifact replayed with two different member IDs.

**Output extraction:** At recording time the system locates each extracted value in the final page text and derives a label-anchored regex (`Savings[ \t]+([^\n\t]+)`), stored in the output definition. Replay applies these patterns to extract the same fields for different inputs — no LLM, no positional assumptions. Extraction is strictly pattern-based: if a pattern is missing or does not match, the output is `null` rather than a guess — for financial data, no answer beats a plausible wrong one.

**Agent contract:** `artifactToToolDefinition()` converts the artifact directly into an Anthropic tool schema, enabling the `agent` CLI to discover and invoke capabilities by name with typed arguments.

## 3. Determinism & error handling

**Determinism strategy:**
1. Fixed viewport (1280×720) and deterministic entry URL
2. Multi-strategy locators with uniqueness check (`count === 1`)
3. Explicit waits via checkpoint assertions, not blind `sleep`
4. Parameter substitution resolved before execution, not interpolated into locators

**Error taxonomy** — three distinct categories in the replay result contract:

| Status | Meaning | Example |
|--------|---------|---------|
| `success` | Goal reached, outputs returned | Balance extracted for member 12345 |
| `business_outcome` | Legitimate answer, not a crash | `MEMBER_NOT_FOUND` for ID 99999 |
| `recoverable` | Transient condition where recovery *failed* | Session dialog dismiss didn't work |
| `failure` | Hard stop with debug evidence | Locator miss at step 3 + screenshot |
| `escalated` | Human intervention requested | Irreversible submit step |

Error handlers are declared in the artifact and checked before and after each step. This separates "the member doesn't exist" (caller needs to know) from "the search button moved" (automation broke). When a recoverable condition is handled successfully (e.g. a session-timeout dialog dismissed), the recovery is written to the audit log and **the run resumes toward the goal** — `recoverable` appears as a terminal status only when recovery itself failed.

**No unstructured failures.** Any exception that escapes per-step handling — an entry-URL policy violation, invalid parameters, a dead browser — is still caught, classified, screenshotted where possible, and written as a structured result. A guardrail that blocks an action but records nothing is itself an audit failure.

**Failure sub-classification.** "Element not found" alone is undecidable — it is produced equally by selector drift, a transient environment issue, and a real app change, and each implies a different response. Hard failures carry a `failureClass`: `locator_miss` (re-record or heal the artifact), `timeout` (retry policy applies), `checkpoint_mismatch` (action ran but state is wrong — app change or bug), `policy_violation` (guardrail fired — review the policy or the artifact), `invalid_input` (the call violated the artifact contract — fix the caller).

**Pre-flight validation.** Before a browser launches, the invocation is checked against the artifact contract (required parameters, types) and the policy step budget. Bad input fails in under a second at a `preflight` step with `failureClass: invalid_input` — a caller error is never allowed to masquerade as a mid-run automation failure.

**Drift detection without failing.** Replay logs *which* locator strategy resolved each step. When the primary strategy misses but a fallback resolves, the run succeeds **and** returns a `driftWarnings` entry naming the step, the dead primary strategy, and what actually resolved — the same telemetry model production self-healing systems use. The artifact keeps working while being flagged for review, instead of failing hard or healing silently.

**Bounded LLM recovery (opt-in `--assist`).** When every strategy for a step misses, replay can make exactly one LLM call constrained by the step's recorded intent: the model may either pick a ref for *this step's action* from the current accessibility snapshot, or give up ("a wrong click in a banking app is worse than a failed run" is in its instructions). The action still passes the policy engine, the corrected locator is captured as a healing candidate (`healed-target-<step>.json`), the model's rationale is written to the hash-chained log, and the result flags `assistedRecoveries` for artifact re-review. This is the middle ground between brittle hard-failure and unauditable improvisation — demonstrated in `/evidence/replay_assisted/`.

**UI drift** is otherwise secondary in this environment — enterprise banking UIs change slowly. The interesting failures are runtime: validation errors, permission denials, unexpected dialogs, session expiry. Checkpoints after critical transitions catch silent failures (click appeared to work but page didn't change).

## 4. Heterogeneity & multi-tenant

**Surface abstraction:** `SurfaceAdapter` defines three operations — `observe()`, `execute()`, `resolveTarget()`. The web implementation uses Playwright; a desktop implementation would use OS accessibility APIs (Windows UI Automation, macOS AXUIElement) returning the same structured observation format. Artifact steps are surface-agnostic (`click`, `fill`, `extract`) — only the adapter translates them to Playwright locators or OS-level element references.

**Frame/iframe handling:** `ElementTarget.framePath[]` records the frame hierarchy for frameset-based legacy apps. The adapter walks frame boundaries before resolving locators. The mock app includes a `/frameset` route demonstrating this pattern.

**Multi-tenant reuse:** Many institutions run the same vendor product with different branding. Rather than re-recording per tenant:

1. Record a **base artifact** against a canonical app instance
2. Store **tenant overlays** with label/route overrides (`"Member #"` → `"Account Number"`)
3. At replay time, merge overlay into locator strategies before resolution
4. Monitor per-tenant checkpoint failure rates to detect drift — re-record only when failure rate exceeds a threshold, not on every config change

The mock app provides `/tenant-a/search` and `/tenant-b/search` with different field labels to demonstrate this model without building tenant infrastructure.

## 5. Escalation & handoff

**Detection triggers:**
- Step marked `riskLevel: "irreversible"` (e.g., submit transfer)
- Error handler with `response.kind: "escalate"`
- Discovery agent explicitly calls the `escalate` tool
- Policy engine blocks an action (out-of-allowlist navigation)

**Control transfer model:**
```
automating (controller: agent)
    → paused_for_human (controller: human)
    → automating (controller: agent, resumed)
```

`SessionManager` holds the same Playwright `BrowserContext` throughout. On escalation, automation pauses but the browser stays open with its cookies, form state, and navigation history intact. The operator console (`npm run operator`) serves a screenshot + context page; the human performs manual steps in the live session, then signals resume.

**Decision packets:** Intervention requests carry the exact action awaiting approval — action type, target description, the parameter value already resolved (redacted if sensitive), and risk level — so the reviewer approves a concrete payload, not a paraphrase. This is the propose-then-commit pattern: the agent proposes, and only what was reviewed executes.

**Evidence across handoff:** Intervention requests capture goal, current step, proposed action, screenshot, and accessibility snapshot. Human decisions are logged to `resolution.json` with disposition, notes, and operator identity (`--as <operator>`), so every gated action is attributable to a person. The seam is real even though full co-browsing is mocked — a production operator console would connect via CDP/WebRTC to the same session.

## 6. Safety

**Allowlist enforcement — two layers:** `PolicyEngine` validates every explicit navigation and action type before execution. Independently, every browser context registers a **network-layer route guard**: all requests — main-frame navigations, link clicks, form posts, redirects, subresources — are checked against the allowlist before leaving the machine. A click on an off-allowlist link renders an explicit "Blocked by policy" page (self-explanatory in screenshots) and no request is sent. During discovery, the `navigate` tool validates the *destination* the model asked for, and violations return to the model as tool errors (logged as evidence) rather than crashing the run.

**Fail-closed human approval:** only an explicitly recognized `approved` or `performed_manually` disposition lets a gated step proceed. Timeout, abort, and any unrecognized disposition (e.g. a tampered `resolution.json`) stop the run — validated at the operator endpoint, in the HITL controller, and again in the replay engine. Verified live by writing a tampered resolution with disposition `yolo_approve`: the run ended with "failing closed" and the irreversible step never executed.

**Risk classification:**
- `safe` — read-only lookups, navigation (auto-proceed)
- `reversible` — form fills that can be undone (auto-proceed with checkpoint)
- `irreversible` — submits, deletes, transfers (escalate to human)

**Data handling:**
- Artifacts store `$param` references, never literal member IDs or credentials
- Evidence logs redact fields marked `sensitive: true` in the parameter/output definitions
- Screenshots captured on failure may contain PII — stored in run-scoped directories, not committed to the artifact itself

**Operator console hardening:** everything the console renders — reasons, goals, step descriptions, proposed actions — originates from artifacts and page content, i.e. from the surface being automated. All of it is HTML-escaped before rendering, and the console binds to loopback only: the application under automation must not be able to script or reach the browser of the human holding approval authority.

**Limits:** The allowlist enforces domains plus path patterns (exact or prefix); a production system would add per-capability route restrictions and rate limiting. Redaction is pattern-based on field names, not content-aware (no NER for SSN detection in free text).

## 7. Cuts

| Cut | Why | Next step |
|-----|-----|-----------|
| Desktop surface adapter | Seam designed, web implemented | Windows UIA adapter using same `SurfaceAdapter` interface |
| Real-time co-browse operator UI | Out of scope per brief | WebRTC session streaming to operator console |
| Artifact approval workflow (draft → approved) | Depth over breadth | Gate unattended replay on N successful replays + human sign-off |
| Automatic artifact healing from drift/recovery data | Healing candidates are captured, merge is manual | Auto-propose artifact updates from `healed-target` evidence, gated on human review |
| Multi-tenant infrastructure | Design only | Tenant overlay merge at replay time + drift monitoring dashboard |
| Frame-path auto-detection during discovery | Manual framePath in artifact | Auto-detect frame context when recording actions |

Built with AI-assisted development (Cursor). Schema and architecture were designed first; implementation was directed module-by-module. All trade-offs above are original decisions documented in `decisions.md`.
