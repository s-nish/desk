// Small marks for where an agent runs: this Mac, or a sandbox provider.

import { Cloud, Laptop, Sailboat } from "lucide-react";
import type { ProviderId } from "../sandbox/types";

function Whale({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="#1D63ED">
      <rect x="4.2" y="9.4" width="2.6" height="2.4" rx=".3" />
      <rect x="7.3" y="9.4" width="2.6" height="2.4" rx=".3" />
      <rect x="10.4" y="9.4" width="2.6" height="2.4" rx=".3" />
      <rect x="13.5" y="9.4" width="2.6" height="2.4" rx=".3" />
      <rect x="7.3" y="6.5" width="2.6" height="2.4" rx=".3" />
      <rect x="10.4" y="6.5" width="2.6" height="2.4" rx=".3" />
      <rect x="10.4" y="3.6" width="2.6" height="2.4" rx=".3" />
      <path d="M1.6 12.6h17.3c.5-1.5 1.8-2.3 3.1-2.1-.2 1-.9 1.8-1.8 2.1-1 4.3-4.9 7.2-10.3 7.2-4.6 0-7.7-2.7-8.3-7.2z" />
    </svg>
  );
}

function ModalMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="#7FEE64">
      <path d="M2 17.5 7.6 6.5h4.3L6.3 17.5z" />
      <path d="M9.4 17.5 15 6.5h4.3l-5.6 11z" opacity=".75" />
      <path d="M12.6 6.5h4.3l5.1 11h-4.3z" opacity=".5" />
    </svg>
  );
}

export function SandboxLogo({ provider, size = 14 }: { provider: ProviderId | "mac"; size?: number }) {
  switch (provider) {
    case "mac": return <Laptop size={size} />;
    case "docker": return <Whale size={size} />;
    case "dockerCloud": return (
      <span className="sandbox-logo-stack" style={{ width: size, height: size }}>
        <Whale size={size} />
        <Cloud size={Math.round(size * 0.62)} className="sandbox-logo-badge" />
      </span>
    );
    case "boat": return <Sailboat size={size} color="#4fb3ff" />;
    case "modal": return <ModalMark size={size} />;
  }
}
