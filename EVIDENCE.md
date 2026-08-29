# Evidence Tour

Every claim in `REPORT.md` maps to a real artifact in `/evidence/`, produced by actual runs (no hand-written fixtures). This index tells you where to look.

All replay evidence derives from **one artifact recorded by a real LLM discovery run** (`evidence/discovery/capability.json`), then replayed deterministically under different inputs and failure conditions.

---

## 1. LLM discovery records a reusable capability

**Claim:** An LLM drives the app once and the run is recorded as a typed, parameterized artifact.

| Look at | What it shows |
|---------|---------------|
| `evidence/discovery/run.json` | Goal, 15 logged steps, real timestamps of the LLM loop |
| `evidence/discovery/snapshots/step-*.yaml` | The accessibility-tree observations the model actually saw |
| `evidence/discovery/capability.json` | The recorded artifact: typed `parameters`/`outputs`, multi-strategy locators, checkpoints, error handlers |

Note in `capability.json`: the agent typed a literal test value during discovery, but the recorded step stores `{"$param": "memberId"}` and descriptions use `<memberId>` — canonicalized automatically, so no PII is baked into the artifact.

## 2. Deterministic replay — no LLM, ~50× faster

**Claim:** Replay executes the artifact without any model call.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_success/result.json` | `success` in ~480ms (discovery took ~19s) |
| `evidence/replay_success/steps.jsonl` | Two steps, each with `locatorStrategyUsed` — which strategy resolved, per step |
| `evidence/replay_other_member/result.json` | Same artifact, different input (`67890` → Robert Johnson) — parameterization proof |
| `evidence/stability/run-*/result.json` | 10/10 stability check, ~310ms per run (predates the hash-chain feature, hence unchained logs) |

## 3. Business outcomes are results, not crashes

**Claim:** "Member not found" is a typed answer for the caller, distinct from automation failure.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_not_found/result.json` | `status: "business_outcome"`, `code: "MEMBER_NOT_FOUND"` for ID 99999 |

## 4. Hard failures are sub-classified

**Claim:** Failures carry a `failureClass` so triage is automatable.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_locator_miss/result.json` | `failureClass: "locator_miss"`, the exact strategies that failed, screenshot reference |
| `evidence/replay_locator_miss/screenshots/error-step_2.png` | Page state at the moment of failure |

## 5. Drift detection on the success path

**Claim:** When a fallback locator saves the run, the run succeeds AND reports drift.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_drift/result.json` | `success` with `driftWarnings`: primary `css=input[name="member_number"]` dead, resolved via `role=textbox` |
| `evidence/replay_drift/steps.jsonl` | The drifted step logged with `"drift": true` and the fallback strategy |

## 6. Bounded LLM recovery (assisted fallback)

**Claim:** On a total locator miss, one policy-checked LLM call may recover the step — recorded, never silent.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_assisted/steps.jsonl` | `assisted_recovery` entry with the model's rationale, inside the hash chain |
| `evidence/replay_assisted/snapshots/assist-step_2.yaml` | The exact snapshot the recovery model saw |
| `evidence/replay_assisted/healed-target-step_2.json` | The corrected locator, captured as a healing candidate for artifact repair |
| `evidence/replay_assisted/result.json` | `success` flagged with `assistedRecoveries: ["step_2"]` — artifact marked for re-review |

## 7. Human-in-the-loop on the same live session

**Claim:** Irreversible steps pause automation; a human approves; the same browser session resumes.

| Look at | What it shows |
|---------|---------------|
| `evidence/interventions/5d753117-*/request.json` | The intervention: reason, blocked step, screenshot + snapshot paths |
| `evidence/interventions/5d753117-*/resolution.json` | Operator disposition (`approved`), notes, attribution, timestamp |
| `evidence/replay_escalation/result.json` | The run completed *after* approval: 26.4s wall clock (dominated by human wait), `interventions` linked by ID |
| `evidence/replay_escalation/screenshots/resumed-after-*.png` | Session state at resume — same session, not a restart |

## 8. Tamper-evident audit log

**Claim:** Step logs are hash-chained; editing or deleting any entry is detectable.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_success/steps.jsonl` | Each entry carries `prevHash` (starting at `genesis`) and its own SHA-256 |
| `scripts/verify-chain.ts` | Verifier CLI: `npx tsx scripts/verify-chain.ts evidence/replay_success/steps.jsonl` |
| `tests/schema.test.ts` | Unit tests proving tampered and deleted entries break the chain |

## 9. Sensitive data redaction

**Claim:** Fields marked `sensitive` are redacted in persisted evidence; discovery logs scrub member names and literal test values from free-text descriptions and snapshots.

| Look at | What it shows |
|---------|---------------|
| `evidence/replay_success/result.json` | `memberName: "[REDACTED]"` — flagged sensitive in the artifact's output definitions |
| `evidence/discovery/result.json` | Same redaction on persisted discovery outputs |
| `evidence/discovery/steps.jsonl` | Step descriptions use `<memberId>` placeholders; done summaries show `[REDACTED]` instead of the member name |

## 10. Guardrails fail closed — and always leave a record

**Claim:** Safety decisions resolve to "stop" under every ambiguous condition, and a blocked action always produces structured evidence. These directories were generated by a self-audit with adversarial inputs.

| Look at | What it shows |
|---------|---------------|
| `evidence/audit_evil_entry/result.json` | Artifact with a disallowed entry URL → structured `failureClass: "policy_violation"` result + screenshot, not a crash |
| `evidence/audit_failclosed/result.json` | Tampered `resolution.json` with disposition `yolo_approve` → run stopped: "Unrecognized disposition — failing closed"; the irreversible step never executed |
| `evidence/interventions/3ab98108-*/resolution.json` | The simulated tampered approval that was rejected |
| `evidence/audit_recovery/steps.jsonl` | Session-timeout dialog detected → `recovered` entry in the hash chain → run *continued* to full success |
| `scripts/test-route-guard.ts` | Network-layer allowlist: external `goto` AND click-triggered navigation both render a "Blocked by policy" page; no request leaves the machine |
| `evidence/preflight_invalid_input/result.json` | Missing required parameter → pre-flight `failureClass: "invalid_input"` in under a second, before any browser launches |

## 11. Agent invokes capabilities as tools

**Claim:** Saved artifacts convert to function-calling tool definitions; a top-level agent selects and invokes them with typed arguments.

| Look at | What it shows |
|---------|---------------|
| `evidence/agent/result.json` | Natural-language ask → capability selected from catalog → replayed → typed outputs returned |
