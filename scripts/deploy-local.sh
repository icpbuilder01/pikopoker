#!/usr/bin/env bash
# Deploys PikoPoker to its own local ICP network (free, for development/
# testing). Separate project from piko-icp and pikopay on purpose -- see
# ../icp.yaml.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Starting local ICP network..."
icp network start -d

echo "==> Deploying test-ledger, pikopoker, pikopoker-frontend..."
icp deploy test-ledger pikopoker pikopoker-frontend -y

TEST_LEDGER_ID=$(icp canister status test-ledger -i)
echo "==> Pointing pikopoker at the local test-ledger ($TEST_LEDGER_ID) instead of its real-mainnet default..."
icp canister call pikopoker setPikoLedgerId "(principal \"$TEST_LEDGER_ID\")"

PIKOPOKER_FRONTEND_ID=$(icp canister status pikopoker-frontend -i)
DEPLOYER_ID=$(icp identity principal)

echo ""
echo "==> Done. Open PikoPoker at:"
echo "    http://${PIKOPOKER_FRONTEND_ID}.localhost:8030/"
echo ""
echo "==> To fund a test account with tPIKO, mint from the deployer identity ($DEPLOYER_ID) to a DIFFERENT principal (self-mint is rejected by the ledger):"
echo "    icp canister call test-ledger icrc1_transfer \"(record { to = record { owner = principal \\\"<some-other-principal>\\\" }; amount = 100_000_000_000_000 })\""
echo ""
echo "==> Each seat also needs to icrc2_approve pikopoker for its buy-in before joining a table, e.g.:"
echo "    icp canister call test-ledger icrc2_approve \"(record { spender = record { owner = principal \\\"$(icp canister status pikopoker -i)\\\" }; amount = 100_000_000_000_000 })\" --identity <that identity>"
