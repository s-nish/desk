import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Gauge } from "lucide-react";
import { AGENTS, TOOL_LABEL, isChatTool, limitKey, projectAccount, useDesk } from "../store";
import { refreshLimits, refreshLiveLimits } from "../actions";
import { relativeTime } from "./Sessions";
import type { Account, Agent, UsageLimits, UsageWindow } from "../types";
import { ToolLogo } from "./ToolLogo";

/** A window whose reset time has passed starts over at 0. */
function effective(w: UsageWindow, now: number) {
  return w.resetsAt && w.resetsAt <= now ? { ...w, used: 0, resetsAt: null } : w;
}

function windowName(w: UsageWindow) {
  if (w.minutes === 10080) return "Weekly";
  if (w.minutes % 60 === 0) return `${w.minutes / 60}-hour`;
  return `${w.minutes}-minute`;
}

function untilText(ms: number, now: number) {
  const minutes = Math.max(1, Math.round((ms - now) / 60000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `in ${Math.round(hours / 24)} d`;
}

function resetText(ms: number, now: number) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `Resets ${day}, ${untilText(ms, now)}`;
}

const level = (used: number) => (used >= 100 ? " is-full" : used >= 80 ? " is-high" : "");

/** "used" or "remaining", from Settings ▸ Usage. Warning colours always follow the share used. */
export function useUsageShow() {
  return useDesk((s) => s.preferences.usageShow ?? "used");
}
const shown = (used: number, mode: "used" | "remaining") => Math.round(mode === "remaining" ? 100 - Math.min(100, used) : used);
const usedText = (used: number, mode: "used" | "remaining") =>
  used >= 100 ? "Limit reached" : mode === "remaining" ? `${shown(used, mode)}% left` : `${Math.round(used)}% used`;

function Meter({ used, wide }: { used: number; wide?: boolean }) {
  const mode = useUsageShow();
  const fill = mode === "remaining" ? 100 - Math.min(100, used) : used;
  return (
    <span className={"usage-meter" + (wide ? " is-wide" : "") + level(used)} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(fill > 0 ? 3 : 0, fill))}%` }} />
    </span>
  );
}

/** Ticks once a minute so reset countdowns stay current while shown. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The account's tightest window, shown in the status bar next to the account. */
export function UsageChip({ account }: { account: Account }) {
  const limits = useDesk((s) => s.limits[limitKey(account.kind, account.dir)]);
  const enabled = useDesk((s) => account.kind === "codex" || s.preferences.usageLimits);
  const now = useNow();
  const mode = useUsageShow();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!enabled) return null;
  const windows = [limits?.session, limits?.weekly].filter(Boolean).map((w) => effective(w!, now));
  const short = (w: UsageWindow) => (w.minutes === 10080 ? "wk" : w.minutes % 60 === 0 ? `${w.minutes / 60}h` : `${w.minutes}m`);
  const label = windows.length ? `${TOOL_LABEL[account.kind]} usage: ${windows.map((w) => `${windowName(w).toLowerCase()} ${Math.round(w.used)}%`).join(", ")}` : `${TOOL_LABEL[account.kind]} usage limits`;
  return (
    <>
      <button ref={ref} className={"status-usage" + (open ? " is-open" : "")} aria-label={label} aria-expanded={open} title={windows.length ? windows.map((w) => `${windowName(w)} limit: ${usedText(w.used, mode)}${w.resetsAt ? `, ${resetText(w.resetsAt, now).toLowerCase()}` : ""}`).join("\n") : "Usage limits"} onClick={() => { setOpen(!open); if (!open) { void refreshLimits(); void refreshLiveLimits(30_000); } }}>
        {windows.length ? windows.map((w) => (
          <span key={w.minutes} className="usage-pair">
            <span className="usage-window-tag">{short(w)}</span>
            <Meter used={w.used} />
            <span className={"usage-percent" + level(w.used)}>{shown(w.used, mode)}%</span>
          </span>
        )) : <Gauge size={12} />}
      </button>
      {open && <UsagePopover anchor={ref} focus={account} onClose={() => setOpen(false)} />}
    </>
  );
}

function WindowRow({ w, now }: { w: UsageWindow; now: number }) {
  const mode = useUsageShow();
  return (
    <div className="usage-window">
      <span className="usage-window-name">{windowName(w)}</span>
      <Meter used={w.used} wide />
      <span className={"usage-window-used" + level(w.used)}>{usedText(w.used, mode)}</span>
      <span className="usage-window-reset">{w.resetsAt ? resetText(w.resetsAt, now) : w.used === 0 ? "Starts with your next request" : ""}</span>
    </div>
  );
}

export function AccountUsage({ account, limits, now, focused = false, logo = false }: { account: Account; limits: UsageLimits | undefined; now: number; focused?: boolean; logo?: boolean }) {
  const windows = [limits?.session, limits?.weekly].filter(Boolean).map((w) => effective(w!, now));
  return (
    <section className={"usage-account" + (focused ? " is-focused" : "")}>
      <header>
        {logo ? <ToolLogo tool={account.kind} size={14} /> : null}
        <span className="usage-dot" style={{ "--acct": account.color } as React.CSSProperties} />
        <strong>{account.name}</strong>
        {limits?.plan && <span className="usage-plan">{limits.plan}</span>}
        {limits && <span className="usage-when">Updated {relativeTime(limits.updated, now)}</span>}
      </header>
      {windows.length ? windows.map((w) => <WindowRow key={w.minutes} w={w} now={now} />) : (
        <p className="usage-empty">{account.kind === "claude" ? "Shows after a Claude Code tab in Desk gets a reply." : account.kind === "codex" ? "Shows after Codex's next request." : `${TOOL_LABEL[account.kind]} doesn't report usage limits to other apps, so Desk can't show them.`}</p>
      )}
    </section>
  );
}

/** Usage for one account: the one whose ring or status chip was clicked. */
function UsagePopover({ anchor, focus, onClose, placement = "status" }: { anchor: React.RefObject<HTMLElement | null>; focus: Account; onClose: () => void; placement?: "status" | "sidebar" }) {
  const limits = useDesk((s) => s.limits[limitKey(focus.kind, focus.dir)]);
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState(8);
  const [side, setSide] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r && placement === "sidebar") setSide({ left: Math.max(8, r.left), bottom: Math.max(8, window.innerHeight - r.top + 8) });
    else if (r) setRight(Math.max(8, window.innerWidth - r.right - 8));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose, placement]);

  // Portaled to <body>: the sidebar footer clips and stacks below the sections above it.
  return createPortal(
    <div ref={ref} className={"usage-popover" + (placement === "sidebar" ? " is-sidebar" : "")} role="dialog" aria-label={`${TOOL_LABEL[focus.kind]} usage`} style={side ? { left: side.left, bottom: side.bottom, right: "auto" } : { right }}>
      <h2 className="usage-pop-title"><ToolLogo tool={focus.kind} size={15} />{TOOL_LABEL[focus.kind]}</h2>
      <AccountUsage account={focus} limits={limits} now={now} />
      <button className="usage-all" onClick={() => { onClose(); useDesk.getState().setModal({ kind: "settings", section: "usage" }); }}>
        All accounts in Settings <ArrowUpRight size={12} />
      </button>
    </div>,
    document.body,
  );
}

/** Ring gauges in the sidebar footer: one per account (Claude Code and Codex), the
 *  selected project's accounts first. The ring fills with the 5-hour window; the
 *  badge shows the 7-day window. More rings than fit scroll sideways (wheel or trackpad), with
 *  faded edges showing there's more; click any ring for every account's details. */
export function UsageRings() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const accounts = useDesk((s) => s.accounts);
  const limits = useDesk((s) => s.limits);
  const claudeOn = useDesk((s) => s.preferences.usageLimits);
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Account | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const mode = useUsageShow();
  const current = new Set(AGENTS.map((k) => (accounts.some((a) => a.kind === k) ? projectAccount(accounts, project, k).id : "")));
  const rings = accounts
    .filter((a) => a.kind !== "github" && (a.kind !== "claude" || claudeOn))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(current.has(y.a.id)) - Number(current.has(x.a.id)) || AGENTS.indexOf(x.a.kind as Agent) - AGENTS.indexOf(y.a.kind as Agent) || x.i - y.i)
    .map(({ a }) => a);
  const sameKind = (a: Account) => accounts.filter((b) => b.kind === a.kind).length > 1;

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useLayoutEffect(measure, [rings.length]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A mouse wheel scrolls the row sideways; trackpads already do.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", onWheel); };
  }, []);

  if (!rings.length) return null;

  return (
    <div className="usage-rings" ref={ref}>
      <div
        ref={scroller}
        className={"usage-rings-scroll" + (edges.start ? " fade-start" : "") + (edges.end ? " fade-end" : "")}
        onScroll={measure}
        role="group"
        aria-label="Usage by account"
      >
        {rings.map((account) => {
          const kind = account.kind;
          const lim = limits[limitKey(account.kind, account.dir)];
          // The ring is the 5-hour window; the badge is the 7-day one.
          const session = lim?.session ? effective(lim.session, now) : null;
          const weekly = lim?.weekly ? effective(lim.weekly, now) : null;
          const pct = (w: UsageWindow | null) => (w ? Math.min(100, Math.max(0, w.used)) : 0);
          const sUsed = pct(session), wUsed = pct(weekly);
          const worst = Math.max(session ? sUsed : 0, weekly ? wUsed : 0);
          const r = 15, c = 2 * Math.PI * r;
          const fill = mode === "remaining" ? 100 - sUsed : sUsed;
          const part = (w: UsageWindow | null, used: number) =>
            w ? `${windowName(w)}: ${usedText(used, mode)}${w.resetsAt ? `, ${resetText(w.resetsAt, now).toLowerCase()}` : ""}` : null;
          const parts = [part(session, sUsed), part(weekly, wUsed)].filter(Boolean);
          const label = parts.length
            ? `${TOOL_LABEL[kind]} · ${account.name}\n${parts.join("\n")}`
            : `${TOOL_LABEL[kind]} · ${account.name}: ${isChatTool(kind) ? "no usage reported yet" : "doesn't report usage limits"}`;
          return (
            <button
              key={account.id}
              className={"usage-ring" + (session || weekly ? level(worst) : " is-empty") + (current.has(account.id) ? " is-current" : "")}
              style={{ "--acct": account.color } as React.CSSProperties}
              aria-label={label}
              title={label}
              onClick={() => { setOpen(open?.id === account.id ? null : account); void refreshLimits(); void refreshLiveLimits(30_000); }}
            >
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="usage-ring-track" cx="18" cy="18" r={r} />
                {session && <circle className={"usage-ring-fill" + level(sUsed)} cx="18" cy="18" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(fill, 2) / 100)} />}
              </svg>
              <span className="usage-ring-glyph"><ToolLogo tool={kind} size={16} /></span>
              {sameKind(account) && <span className="usage-ring-acct" aria-hidden="true" />}
              {weekly && <span className={"usage-ring-value" + level(wUsed)}>{shown(wUsed, mode)}%</span>}
            </button>
          );
        })}
      </div>
      {open && <UsagePopover anchor={ref} focus={open} placement="sidebar" onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Settings ▸ Usage: every account's limits on one page, with the used/left switch. */
export function UsageSettings() {
  const accounts = useDesk((s) => s.accounts);
  const limits = useDesk((s) => s.limits);
  const claudeOn = useDesk((s) => s.preferences.usageLimits);
  const mode = useUsageShow();
  const set = useDesk((s) => s.setPreferences);
  const now = useNow();
  useEffect(() => { void refreshLimits(); void refreshLiveLimits(30_000); }, []);
  const kinds = AGENTS.filter((k) => accounts.some((a) => a.kind === k));
  return (
    <div className="usage-settings">
      <div className="usage-settings-head">
        <div>
          <strong>Show</strong>
          <small>Applies to the sidebar rings, the status bar and this page.</small>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Show usage as">
          {(["used", "remaining"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : ""} onClick={() => set({ usageShow: m })}>
              {m === "used" ? "Used" : "Remaining"}
            </button>
          ))}
        </div>
      </div>
      {kinds.map((kind) => (
        <section key={kind} className="usage-settings-tool">
          <h3><ToolLogo tool={kind} size={15} />{TOOL_LABEL[kind]}</h3>
          {kind === "claude" && !claudeOn ? (
            <p className="usage-empty">Claude Code usage limits are off. <button className="text-button" onClick={() => set({ usageLimits: true })}>Turn them on</button></p>
          ) : (
            <div className="usage-settings-cards">
              {accounts.filter((a) => a.kind === kind).map((a) => (
                <div key={a.id} className="usage-card">
                  <AccountUsage account={a} limits={isChatTool(kind) ? limits[limitKey(a.kind, a.dir)] : undefined} now={now} />
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
      <p className="settings-note">Claude Code and Codex report limits with each reply, so numbers can be a few minutes old. Gemini CLI, Cursor Agent, Grok and OpenCode don't report limits to other apps.</p>
    </div>
  );
}
