/** The 5-hour window as a small ring. Warning colours follow the share used. */
export function UsageRing({ used, color, size = 14 }: { used: number; color: string | null; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, used));
  const stroke = pct >= 100 ? "#ff6b6b" : pct >= 80 ? "#fc734d" : color ?? "#3db8f5";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ffffff22" strokeWidth="2" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
