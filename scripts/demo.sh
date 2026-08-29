#!/usr/bin/env bash
# Demo commands for reviewers — run `npm run mock-app` in another terminal first.
set -euo pipefail

echo "=== Discovery (LLM, ~15s) ==="
npm run discover -- \
  --goal "Look up a member by their member ID and read their savings balance" \
  --target http://localhost:3000/search \
  --params '{"memberId":"12345"}' \
  --output ./evidence/discovery-demo \
  --headed

echo "=== Replay — different member (~350ms, no LLM) ==="
npm run replay -- \
  --capability artifacts/lookup_savings_balance.json \
  --params '{"memberId":"67890"}'

echo "=== Business outcome — member not found ==="
npm run replay -- \
  --capability artifacts/lookup_savings_balance.json \
  --params '{"memberId":"99999"}'

echo "=== HITL escalation (headed; approve via operator console when paused) ==="
npm run replay -- \
  --capability artifacts/open_subaccount.json \
  --params '{"memberId":"12345","accountType":"savings"}' \
  --output ./evidence/escalation-demo \
  --headed \
  --linger 5000
# When paused: npm run operator -- --intervention <id> --port 4100 --as jane.ops

echo "=== Drift + bounded recovery ==="
npm run replay -- --capability artifacts/demo/broken_locator.json --params '{"memberId":"12345"}'
npm run replay -- --capability artifacts/demo/broken_locator.json --params '{"memberId":"12345"}' --assist
