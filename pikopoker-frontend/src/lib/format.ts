const DECIMALS = 8; // both PIKO and ICP use 8 decimals
const DECIMALS_FACTOR = 10n ** BigInt(DECIMALS);

export function formatAmount(raw: bigint | number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
  const whole = value / DECIMALS_FACTOR;
  const frac = value % DECIMALS_FACTOR;
  const fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return fracStr.length > 0 ? `${wholeStr}.${fracStr}` : wholeStr;
}

export const formatPiko = formatAmount;
export const formatIcp = formatAmount;

/** Parses a user-typed decimal amount (e.g. "1.5") into raw e8s, or null if invalid. */
export function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > DECIMALS) return null;
  const paddedFrac = fracPart.padEnd(DECIMALS, "0");
  try {
    return BigInt(wholePart) * DECIMALS_FACTOR + BigInt(paddedFrac || "0");
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function shortPrincipal(principal: string): string {
  if (principal.length <= 16) return principal;
  const parts = principal.split("-");
  if (parts.length <= 2) return principal;
  return `${parts[0]}...${parts[parts.length - 1]}`;
}

export function timeAgo(nanoseconds: bigint): string {
  const ms = Number(nanoseconds / 1_000_000n);
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
