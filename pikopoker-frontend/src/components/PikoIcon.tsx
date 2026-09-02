interface PikoIconProps {
  size?: number;
}

export function PikoIcon({ size = 14 }: PikoIconProps) {
  return <img src="/piko-logo.svg" alt="" className="piko-icon" width={size} height={size} />;
}
