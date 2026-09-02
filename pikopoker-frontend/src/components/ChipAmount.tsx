import { formatPiko } from "../lib/format";
import { PikoIcon } from "./PikoIcon";

interface ChipAmountProps {
  amount: bigint;
  unit: string;
  size?: number;
}

// Real PIKO gets the little PIKO mark (matching the mining app's amount
// display); the Free Play table's play-money "chips" don't, since they
// aren't the real token.
export function ChipAmount({ amount, unit, size = 13 }: ChipAmountProps) {
  return (
    <span className="chip-amount">
      {unit === "PIKO" && <PikoIcon size={size} />}
      {formatPiko(amount)} {unit}
    </span>
  );
}
