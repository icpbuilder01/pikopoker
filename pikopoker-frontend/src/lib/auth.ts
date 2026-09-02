import { AuthClient } from "@icp-sdk/auth/client";

// Defaults to the current Internet Identity frontend (id.ai) already.
const MAX_TTL_NANOSECONDS = BigInt(8 * 60 * 60) * BigInt(1_000_000_000); // 8h

// Every IC canister is reachable from at least two real, distinct origins
// -- <id>.icp.net (the only one this project ever links to) and
// <id>.icp0.io (a standard boundary-node domain, works identically, never
// advertised but real). Internet Identity derives a different principal
// per origin by design, so the same II anchor produces two different
// principals for this same site depending purely on which domain happened
// to be open -- see ~/piko-icp/frontend/src/lib/auth.ts's own comment for
// the full story (a real user-reported bug on the mining site, same root
// cause, same fix, applied here too). Skipped for local dev, where the
// canonical mainnet origin isn't relevant.
const CANONICAL_ORIGIN = "https://2uuxi-qyaaa-aaaac-qhbyq-cai.icp.net";

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  if (!authClientPromise) {
    authClientPromise = Promise.resolve(new AuthClient());
  }
  return authClientPromise;
}

export async function login() {
  const client = await getAuthClient();
  const isLocal = window.location.hostname.endsWith("localhost");
  return client.signIn({
    maxTimeToLive: MAX_TTL_NANOSECONDS,
    ...(isLocal ? {} : { derivationOrigin: CANONICAL_ORIGIN }),
  });
}

export async function logout() {
  const client = await getAuthClient();
  await client.signOut();
}

export async function getStoredIdentity() {
  const client = await getAuthClient();
  return client.isAuthenticated() ? client.getIdentity() : null;
}
