import type { SVGProps } from "react";

/** Desk's mark: a 5×7 pixel-grid D. Monochrome: takes the theme's text colour. */
export function DeskLogo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-1.56 -0.56 8 8" fill="none" aria-hidden="true" {...props}>
      <path d="M0 0h0.88v0.88h-0.88zM1 0h0.88v0.88h-0.88zM2 0h0.88v0.88h-0.88zM3 0h0.88v0.88h-0.88zM0 1h0.88v0.88h-0.88zM4 1h0.88v0.88h-0.88zM0 2h0.88v0.88h-0.88zM4 2h0.88v0.88h-0.88zM0 3h0.88v0.88h-0.88zM4 3h0.88v0.88h-0.88zM0 4h0.88v0.88h-0.88zM4 4h0.88v0.88h-0.88zM0 5h0.88v0.88h-0.88zM4 5h0.88v0.88h-0.88zM0 6h0.88v0.88h-0.88zM1 6h0.88v0.88h-0.88zM2 6h0.88v0.88h-0.88zM3 6h0.88v0.88h-0.88z" style={{ fill: "var(--text, currentColor)" }} />
    </svg>
  );
}
