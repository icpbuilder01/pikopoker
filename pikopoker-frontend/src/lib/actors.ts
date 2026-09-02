import type { Identity } from "@icp-sdk/core/agent";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createPikopokerActor } from "../bindings/pikopoker/pikopoker";
import { pikopokerCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

export function getPikopokerActor(identity?: Identity) {
  return createPikopokerActor(pikopokerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getLedgerActor(identity?: Identity) {
  return createLedgerActor(ledgerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}
