import type { SVGProps } from "react";

/** Desk's split monogram: an offset spine and a continuous curved plane. */
export function DeskLogo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path d="M4 9 9 6v20l-5 3V9Z" fill="currentColor" />
      <path d="M12 4h5a12 12 0 0 1 0 24h-5v-5h5a7 7 0 0 0 0-14h-5V4Z" fill="currentColor" />
    </svg>
  );
}
