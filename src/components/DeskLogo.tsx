import type { SVGProps } from "react";

/** A workspace frame and prompt, matching the dark macOS app icon. */
export function DeskLogo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <rect x="3" y="4" width="26" height="24" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4 10h24" stroke="currentColor" strokeWidth="1.5" opacity=".55" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <path d="m9 15 4 4-4 4m9 0h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
