import type { SVGProps } from "react";

/** The app icon's terminal window and prompt, drawn in the current text color
 * so it is white on dark themes and black on the light one. */
export function DeskLogo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <rect x="3" y="5" width="26" height="22" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4 10.5h24" stroke="currentColor" strokeWidth="1.2" opacity=".35" />
      <circle cx="6.8" cy="7.8" r=".9" fill="currentColor" />
      <circle cx="9.6" cy="7.8" r=".9" fill="currentColor" opacity=".55" />
      <path d="m10 15 3.5 3.25L10 21.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 21.5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
