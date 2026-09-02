import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:pikopoker": string;
  readonly "PUBLIC_CANISTER_ID:test-ledger": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const pikopokerCanisterId = canisterEnv["PUBLIC_CANISTER_ID:pikopoker"];
export const rootKey = canisterEnv.IC_ROOT_KEY;

// See pikopay-frontend's canister-env.ts for the identical reasoning: only
// the local gateway serves from a *.localhost host, so that's enough to
// tell local dev apart from mainnet.
const isLocal = window.location.hostname.endsWith("localhost");

// The real, live PIKO ledger on mainnet -- pikopoker itself defaults to
// this same id (see pikopoker/src/main.mo's pikoLedgerId) and only ever
// gets redirected to a local test-ledger for local development. The
// frontend mirrors that same default here purely for balance/approve
// display; the canister's own idea of the ledger is the one that actually
// matters for correctness.
const REAL_PIKO_LEDGER_CANISTER_ID = "56aad-fiaaa-aaaaj-qsefa-cai";
export const ledgerCanisterId = isLocal
  ? canisterEnv["PUBLIC_CANISTER_ID:test-ledger"]
  : REAL_PIKO_LEDGER_CANISTER_ID;

// A fixed mainnet URL, not a same-project canister lookup -- PikoPoker
// isn't part of piko-icp's own project (see ../icp.yaml). This is
// pikopoker-frontend's own mainnet canister id (deployed 2026-08-20), not
// shared with any other project's frontend.
export const frontendUrl = "https://2uuxi-qyaaa-aaaac-qhbyq-cai.icp.net/";
