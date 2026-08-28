# Architecture & Design Decisions

Private working doc for interview prep. One line per choice + rationale.

---

## Surface & Perception

**Accessibility tree over screenshot/coordinate computer use**
Legacy bank UIs have table layouts and framesets — semantic roles + labels survive better than pixels. Cheaper (no vision model), faster, and artifacts capture durable locators instead of ephemeral coordinates.

**Playwright as surface driver, not Stagehand/Browser Use as the system**
Stagehand solves the same problem but outsources the artifact schema, error taxonomy, and replay contract — exactly what interface.ai evaluates. Playwright gives us the accessibility tree and action primitives; we own the design on top.

**`page.locator('body').ariaSnapshot()` for discovery, semantic locators for replay**
During discovery the LLM acts on ephemeral `aria-ref=eN` IDs from the snapshot. The recorder captures role/label/text strategies at action time. Replay never uses aria-ref — those are invalid after DOM changes.

**Multi-strategy locators with ordered fallbacks**
Primary: role + accessible name. Secondary: label/placeholder. Tertiary: structural xpath (no positional indexes). Replay tries each until one resolves uniquely.

---

## Artifact Schema

**Capability artifact as agent-invocable contract, not a step log**
Typed `parameters` and `outputs` (Zod-validated) so a calling agent knows exactly what to supply and what it gets back. `artifactToToolDefinition()` converts directly to function-calling schema.

**`$param:name` syntax for parameterization**
Values like member IDs are referenced, never hardcoded. Artifacts stay reusable across invocations. Sensitive params flagged for redaction.

**`riskLevel` on every step (`safe` | `reversible` | `irreversible`)**
Read-only lookups are safe. Form submissions that reach confirmation are irreversible → trigger HITL escalation before proceeding.

**Versioned schema (`schemaVersion: "1.0"`)**
Artifacts are reviewable and migratable. Breaking changes bump the version; replay engine validates on load.

---

## Error Handling

**Three-tier result contract, not binary success/failure**
- `business_outcome` — legitimate answer the caller needs (e.g. MEMBER_NOT_FOUND)
- `recoverable` — transient condition handled automatically (session timeout dialog)
- `failure` — hard stop with step, expected, observed, and screenshot evidence

**Error handlers declared in the artifact, checked before and after each step**
Detection is text/url/dialog presence. Response kind determines whether to return a business outcome, attempt recovery, or escalate.

**Checkpoints at key steps, not just at the end**
Assumes the click worked is the most common replay mistake. Assert text present, element visible, or extract match after critical transitions.

**`failureClass` on hard failures (`locator_miss` | `timeout` | `checkpoint_mismatch` | `policy_violation`)**
"Element not found" is undecidable on its own — drift, transient issue, and app change all produce it, and each needs a different response. Classifying at the point of failure (typed errors, not string matching) makes triage automatable.

**Drift detection as a success-path signal, not a failure**
Replay logs which locator strategy resolved each step. Primary missed but fallback resolved → run succeeds AND `driftWarnings` names the dead strategy. The artifact keeps working while flagged for review — never fails hard, never heals silently.

**Bounded LLM recovery, opt-in (`--assist`), one call, two tools**
On a total locator miss the model gets the step's recorded intent + current snapshot and may only `resolve_element` (pick a ref for this step's action) or `give_up`. The action still passes policy; the corrected locator is saved as a healing candidate; the rationale goes in the hash-chained log; the result flags the artifact for re-review. Middle ground between brittle hard-failure and unauditable improvisation.

---

## Target Application

**Local legacy mock ("Meridian CU Core") over a public site**
Full control over error injection (not-found, timeout, permission denied), no ToS/rate-limit risk, and it demonstrates understanding of the real environment (table layouts, framesets, no test IDs). Tenant variants (A/B) enable multi-tenant reuse demo without building multi-tenant infra.

**Intentionally hostile markup**
No `data-testid`, minimal ARIA, table-based forms with label/input in adjacent `<td>` cells. Proves the locator strategy works on legacy surfaces, not just clean React apps.

---

## Human-in-the-Loop

**Same browser session throughout — never spawn a fresh one on escalation**
`SessionManager` holds the Playwright `BrowserContext`. Pause sets `controller: "human"`; automation refuses to act until resume. Context and cookies preserved.

**Minimal operator console (screenshot + context + resume), not co-browse**
Full real-time co-browsing is out of scope per the brief. The seam is real: intervention request JSON, screenshot, operator notes, resolution record. Design for the full console is in REPORT.md.

**Escalation triggers: irreversible steps, repeated failures, policy blocks**
Not just "LLM gave up" — explicit conditions tied to risk level and error handlers.

**Decision packets: the reviewer approves a payload, not a paraphrase**
Intervention requests carry the exact pending action (type, target, resolved parameter value — redacted if sensitive, risk level). Propose-then-commit: only what was reviewed executes.

**Operator attribution on every resolution**
`resolution.json` records disposition, notes, and who (`--as <operator>`). In a regulated environment "a human approved it" is insufficient — which human matters.

---

## Safety

**Explicit domain/path allowlist in PolicyEngine**
Agent cannot navigate outside `localhost:3000`. Action types also allowlisted. Checked before every navigation and action.

**Allowlist enforced at the network layer, not just at `goto`**
`context.route("**/*")` checks every request against policy — link clicks, form posts, redirects, subresources. Explicit-navigation checks alone don't cover UI-triggered navigation. Blocked document requests render a "Blocked by policy" page so post-block screenshots are self-explanatory.

**Every ambiguous safety decision fails closed**
Only recognized `approved`/`performed_manually` dispositions proceed; timeout, abort, and unrecognized values stop the run — validated at the endpoint, the controller, and the engine (defense in depth, verified by live tamper test). Unhandled exceptions produce a classified, structured failure result — a guardrail that blocks but doesn't record is itself an audit failure.

**Redaction in evidence logs, not in artifacts**
Artifacts store `$param:memberId` references — in step values AND free-text descriptions (the recorder scrubs test values from prose too, since a value surviving in a description defeats value-level parameterization). Logs and CLI output redact sensitive keys at write time. Never persist credentials or raw PII.

**Pre-flight contract validation before any browser launches**
Required parameters, types, and the policy step budget are checked first; violations fail in <1s as `failureClass: invalid_input` (or `policy_violation`) with no browser session. A caller error must never surface as a mid-run "unknown" failure.

**Declared policy controls are all enforced**
`allowedPathPatterns` is checked in `assertNavigationAllowed` (exact, prefix-`*`, or `*`); `maxStepsPerRun` rejects over-budget artifacts at pre-flight. A documented control without an implementation is the classic audit finding — we don't carry any.

**Operator console treats the automated surface as hostile**
All rendered strings (reasons, goals, descriptions, proposed actions) originate from artifacts and page content and are HTML-escaped; the console binds loopback only. The app being automated must not be able to script the browser of the human holding approval authority.

**Irreversible actions gated, not blocked silently**
Sub-account submit requires human approval via HITL. Safer than auto-proceeding and more honest than hard-blocking without a path forward.

---

## Architecture

**Single-process monolith with clean module boundaries**
No queues, no k8s, no multi-tenant DB — explicitly anti-signals per the brief. Modules (`SurfaceAdapter`, `ReplayEngine`, `PolicyEngine`, `HitlController`) are separable if scaling requires it later.

**SurfaceAdapter as the heterogeneity seam**
Web implementation uses Playwright today. Desktop would swap in an OS accessibility API adapter; artifact steps stay unchanged. Discussed in REPORT.md Section 4.

**Evidence as structured JSON + screenshots, append-only step log**
Every run gets a UUID, mode, initiator, and hash-chained step records (SHA-256 of the previous entry in each record; `EvidenceLogger.verifyChain` finds the first broken link — unit-tested against tampered and deleted entries). Auditability matters in regulated financial environments.

---

## Stretch Goals (prioritized)

1. **Agent-facing capability catalog** — `npm run agent` invokes saved artifacts via tool calling. Closes the product loop.
2. **Cross-tenant reuse** — base artifact + label overrides for tenant-a vs tenant-b.
3. **Multi-run stability** — `--times 10` reports pass rate and per-step timing variance.

---

## Explicit Cuts

- Desktop surface adapter (designed, not built)
- Real-time co-browse operator UI (mocked at clean seam)
- Artifact approval workflow (draft → approved)
- Automatic artifact healing (healing candidates captured; merge left manual)
- Multi-tenant infrastructure (DB, tenant routing)

---

## AI-Assisted Development

Built with Cursor. Schema and architecture designed first, then module-by-module implementation directed to AI. Discovery agent prompt hand-tuned after initial runs. All trade-offs in this file and REPORT.md are original decisions, not generated defaults.
