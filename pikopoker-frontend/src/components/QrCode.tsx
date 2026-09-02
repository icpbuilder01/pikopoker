import { useMemo } from "react";
import QRCode from "qrcode";

interface QrCodeProps {
  value: string;
  size?: number;
}

// Renders modules as plain SVG rects with fill="currentColor" instead of
// using the library's own toString()/toDataURL() renderers -- those bake in
// a fixed hex color pair, which would either be unreadable (dark-on-dark)
// or force a hardcoded light background that ignores the site's dark theme.
export function QrCode({ value, size = 200 }: QrCodeProps) {
  const modules = useMemo(() => {
    try {
      return QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
    } catch (err) {
      console.error("Failed to generate QR code", err);
      return null;
    }
  }, [value]);

  if (!modules) {
    return <div className="empty-state">Couldn't generate a QR code for this.</div>;
  }

  const quietZone = 2;
  const dimension = modules.size + quietZone * 2;
  const rects: React.ReactElement[] = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) {
        rects.push(<rect key={`${row}-${col}`} x={col + quietZone} y={row + quietZone} width={1} height={1} />);
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="qr-svg"
      role="img"
      aria-label="PikoPoker wallet QR code"
    >
      <rect x={0} y={0} width={dimension} height={dimension} fill="var(--surface)" />
      <g fill="var(--text)">{rects}</g>
    </svg>
  );
}
