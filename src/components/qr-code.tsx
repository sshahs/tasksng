import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code drawn as SVG (no images, so it works under the strict CSP). */
export function QrCode({ value, size = 200, className }: { value: string; size?: number; className?: string }) {
  const { cells, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const cells: string[] = [];
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
    return { cells: cells.join(""), count };
  }, [value]);
  const box = count + 8;
  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Pairing code"
      shapeRendering="crispEdges"
    >
      <rect width={box} height={box} fill="#fff" rx={2} />
      <path d={cells} fill="#09090b" />
    </svg>
  );
}
