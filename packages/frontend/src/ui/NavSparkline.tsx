/**
 * NavSparkline — a minimal SVG line chart for NAV-per-share history.
 *
 * Props:
 *   points   — array of bigint NAV values (18-decimal), oldest first
 *   width    — SVG width in px (default 120)
 *   height   — SVG height in px (default 36)
 *   positive — colour the line green; false = red; undefined = auto-detect from trend
 */

interface Props {
  points: bigint[];
  width?: number;
  height?: number;
  positive?: boolean;
}

export function NavSparkline({ points, width = 120, height = 36, positive }: Props) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#6b7280" strokeWidth={1.5} />
      </svg>
    );
  }

  const first = points[0] ?? 0n;
  const min = points.reduce((a, b) => (b < a ? b : a), first);
  const max = points.reduce((a, b) => (b > a ? b : a), first);
  const range = max - min || 1n;

  const pad = 3; // vertical padding in px
  const usableH = height - pad * 2;

  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = pad + usableH - Number(((v - min) * BigInt(usableH)) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = coords.join(" ");

  const trend = (points[points.length - 1] ?? 0n) >= (points[0] ?? 0n);
  const isPositive = positive !== undefined ? positive : trend;
  const stroke = isPositive ? "#2ebd85" : "#f23645";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
      <polyline
        points={polyline}
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
