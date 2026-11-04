import { Pause, Settings2, Sparkles } from "lucide-react";
import { useDesk } from "../store";
import { Ambient } from "./Ambient";
import { UsageRings } from "./Usage";

/** Bottom of both sidebars: usage rings, the background-animation switch, and Settings,
 *  over a short strip of the theme's pixel waves. */
export function SidebarFooter() {
  const animated = useDesk((s) => s.preferences.animatedBackground);
  const set = useDesk((s) => s.setPreferences);
  return (
    <div className="sidebar-foot">
      <Ambient variant="strip" />
      <div className="sidebar-foot-row">
        <UsageRings />
        <span className="sidebar-foot-spacer" />
        {(
          <button
            className="foot-btn"
            role="switch"
            aria-checked={animated}
            aria-label="Animated background"
            title={animated ? "Pause the pixel animation" : "Animate the pixel background"}
            onClick={() => set({ animatedBackground: !animated })}
          >
            {animated ? <Pause size={14} /> : <Sparkles size={14} />}
          </button>
        )}
        <button className="foot-btn" aria-label="Settings" title="Settings (⌘,)" onClick={() => useDesk.getState().setModal({ kind: "settings" })}>
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}
