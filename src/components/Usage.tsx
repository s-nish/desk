import { useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import { TOOL_LABEL, limitKey, useDesk } from "../store";
import { refreshLimits } from "../actions";
import { relativeTime } from "./Sessions";
import type { Account, UsageLimits, UsageWindow } from "../types";

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

function Meter({ used, wide }: { used: number; wide?: boolean }) {
  return (
    <span className={"usage-meter" + (wide ? " is-wide" : "") + level(used)} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(used > 0 ? 3 : 0, used))}%` }} />
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!enabled) return null;
  const windows = [limits?.session, limits?.weekly].filter(Boolean).map((w) => effective(w!, now));
  const short = (w: UsageWindow) => (w.minutes === 10080 ? "wk" : w.minutes % 60 === 0 ? `${w.minutes / 60}h` : `${w.minutes}m`);
  const label = windows.length ? `${TOOL_LABEL[account.kind]} usage: ${windows.map((w) => `${windowName(w).toLowerCase()} ${Math.round(w.used)}%`).join(", ")}` : `${TOOL_LABEL[account.kind]} usage limits`;
  return (
    <>
      <button ref={ref} className={"status-usage" + (open ? " is-open" : "")} aria-label={label} aria-expanded={open} title={windows.length ? windows.map((w) => `${windowName(w)} limit: ${Math.round(w.used)}% used${w.resetsAt ? `, ${resetText(w.resetsAt, now).toLowerCase()}` : ""}`).join("\n") : "Usage limits"} onClick={() => { setOpen(!open); if (!open) void refreshLimits(); }}>
        {windows.length ? windows.map((w) => (
          <span key={w.minutes} className="usage-pair">
            <span className="usage-window-tag">{short(w)}</span>
            <Meter used={w.used} />
            <span className={"usage-percent" + level(w.used)}>{Math.round(w.used)}%</span>
          </span>
        )) : <Gauge size={12} />}
      </button>
      {open && <UsagePopover anchor={ref} focus={account} onClose={() => setOpen(false)} />}
    </>
  );
}

function WindowRow({ w, now }: { w: UsageWindow; now: number }) {
  const used = Math.round(w.used);
  return (
    <div className="usage-window">
      <span className="usage-window-name">{windowName(w)}</span>
      <Meter used={w.used} wide />
      <span className={"usage-window-used" + level(w.used)}>{used >= 100 ? "Limit reached" : `${used}% used`}</span>
      <span className="usage-window-reset">{w.resetsAt ? resetText(w.resetsAt, now) : w.used === 0 ? "Starts with your next request" : ""}</span>
    </div>
  );
}

function AccountUsage({ account, limits, now, focused }: { account: Account; limits: UsageLimits | undefined; now: number; focused: boolean }) {
  const windows = [limits?.session, limits?.weekly].filter(Boolean).map((w) => effective(w!, now));
  return (
    <section className={"usage-account" + (focused ? " is-focused" : "")}>
      <header>
        <span className="usage-dot" style={{ "--acct": account.color } as React.CSSProperties} />
        <strong>{account.name}</strong>
        {limits?.plan && <span className="usage-plan">{limits.plan}</span>}
        {limits && <span className="usage-when">Updated {relativeTime(limits.updated, now)}</span>}
      </header>
      {windows.length ? windows.map((w) => <WindowRow key={w.minutes} w={w} now={now} />) : (
        <p className="usage-empty">{account.kind === "claude" ? "Shows after a Claude Code tab in Desk gets a reply." : "Shows after Codex's next request."}</p>
      )}
    </section>
  );
}

function UsagePopover({ anchor, focus, onClose }: { anchor: React.RefObject<HTMLButtonElement | null>; focus: Account; onClose: () => void }) {
  const accounts = useDesk((s) => s.accounts);
  const limits = useDesk((s) => s.limits);
  const claudeOn = useDesk((s) => s.preferences.usageLimits);
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState(8);

  useEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setRight(Math.max(8, window.innerWidth - r.right - 8));
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
  }, [anchor, onClose]);

  const kinds = (["claude", "codex"] as const).filter((k) => k === "codex" || claudeOn);
  return (
    <div ref={ref} className="usage-popover" role="dialog" aria-label="Usage limits" style={{ right }}>
      <h2>Usage limits</h2>
      {kinds.map((kind) => (
        <div key={kind} className="usage-tool">
          <h3>{TOOL_LABEL[kind]}</h3>
          {accounts.filter((a) => a.kind === kind).map((a) => (
            <AccountUsage key={a.id} account={a} limits={limits[limitKey(a.kind, a.dir)]} now={now} focused={a.id === focus.id} />
          ))}
        </div>
      ))}
      <p className="usage-note">Claude Code and Codex report these with each reply. Numbers can be a few minutes old.</p>
    </div>
  );
}
