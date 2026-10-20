import type { SVGProps } from "react";

/** Desk's open-D mark: a sidebar, a workspace, and a warm focus indicator. */
export function DeskLogo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="240 240 544 544" fill="none" aria-hidden="true" {...props}>
      <rect x="292" y="264" width="104" height="496" rx="30" fill="currentColor" />
      <path d="M480 316H502C631 316 708 390 708 512S631 708 502 708H480" stroke="currentColor" strokeWidth="104" strokeLinecap="round" />
      <rect x="456" y="466" width="132" height="92" rx="25" fill="var(--ui-accent, #dedbd4)" />
    </svg>
  );
}
