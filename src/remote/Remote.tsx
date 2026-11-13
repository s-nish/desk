// Desk on your phone, over your tailnet: every open chat and agent tab, and the
// whole conversation of the one you open, live. It can allow (once), deny,
// reply and stop; nothing else. Served by remote.rs, fed by phoneBridge.ts.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Search, Square, X } from "lucide-react";
import { ToolLogo } from "../components/ToolLogo";
import { SandboxLogo } from "../components/SandboxLogo";
import { Markdown } from "../markdown";
import { UsageRing } from "../feedui/UsageRing";
import type { PhoneAction, PhoneEntry, PhonePayload, PhoneSession, PhoneThread } from "./protocol";

const AGENT: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", cursor: "Cursor", grok: "Grok", opencode: "OpenCode", shell: "Terminal" };

type Link = "connecting" | "live" | "offline" | "unpaired";

async function post(action: PhoneAction) {
  const res = await fetch("/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action), credentials: "same-origin" });
  if (!res.ok) throw new Error((await res.text()) || `Desk said ${res.status}`);
}

const tap = () => { try { navigator.vibrate?.(8); } catch { /* not on iOS */ } };

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The live feed from Desk, over server-sent events, reconnecting on its own. */
function useFeed() {
  const [feed, setFeed] = useState<PhonePayload>({ sessions: [], usage: [], threads: {} });
  const [link, setLink] = useState<Link>("connecting");
  const again = useRef<() => void>(() => {});
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let wait = 1000;
    let stopped = false;
    const connect = async () => {
      if (stopped) return;
      // EventSource hides the status; ask once so an unpaired phone says so.
      const probe = await fetch("/events", { method: "HEAD", credentials: "same-origin" }).catch(() => null);
      if (probe?.status === 401) { setLink("unpaired"); return; }
      source?.close();
      source = new EventSource("/events", { withCredentials: true });
      source.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as Partial<PhonePayload>;
          setFeed({ sessions: data.sessions ?? [], usage: data.usage ?? [], threads: data.threads ?? {} });
          setLink("live");
          wait = 1000;
        } catch { /* a ping */ }
      };
      source.onerror = () => {
        source?.close();
        setLink("offline");
        if (retry) clearTimeout(retry);
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 15_000);
      };
    };
    void connect();
    const now = () => { if (retry) clearTimeout(retry); wait = 1000; setLink((l) => (l === "live" ? l : "connecting")); void connect(); };
    again.current = now;
    const wake = () => { if (document.visibilityState === "visible") now(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => { stopped = true; source?.close(); if (retry) clearTimeout(retry); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, []);
  const retry = useCallback(() => again.current(), []);
  return { feed, link, retry };
}

function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

export function Remote() {
  const { feed, link, retry } = useFeed();
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(location.hash.slice(1)).get("s"));
  const [leaving, setLeaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  // The back button and the edge swipe both go through history.
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("s");
      setOpenId((cur) => { if (cur && !id) { setLeaving(cur); setTimeout(() => setLeaving(null), 380); } return id; });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const open = (id: string) => { tap(); history.pushState(null, "", `#s=${encodeURIComponent(id)}`); setOpenId(id); };
  const back = () => { if (history.state !== undefined && location.hash) history.back(); else { setLeaving(openId); setOpenId(null); setTimeout(() => setLeaving(null), 380); } };

  const act = useCallback((action: PhoneAction) => post(action).then(() => setError(""), (e: Error) => { setError(e.message); throw e; }), []);

  if (link === "unpaired") {
    return (
      <main className="ph-empty">
        <div className="ph-empty-mark"><CircleAlert size={28} /></div>
        <h1>Not paired</h1>
        <p>On your Mac, open Desk ▸ Settings ▸ Phone, turn on the phone remote and scan the code with this phone.</p>
        <button className="ph-again" onClick={retry}>Try again</button>
      </main>
    );
  }

  const shownId = openId ?? leaving;
  const session = feed.sessions.find((s) => s.id === shownId) ?? null;
  return (
    <div className={"ph-stack" + (openId ? " is-deep" : "")}>
      <ListScreen feed={feed} link={link} onOpen={open} act={act} retry={retry} />
      {shownId && (
        <ThreadScreen
          key={shownId}
          id={shownId}
          session={session}
          thread={feed.threads[shownId] ?? null}
          leaving={!openId}
          link={link}
          retry={retry}
          onBack={back}
          act={act}
        />
      )}
      {error && <div className="ph-toast" role="alert" onClick={() => setError("")}>{error}</div>}
    </div>
  );
}

// The list

function LinkPill({ link, retry }: { link: Link; retry: () => void }) {
  if (link === "live") return <span className="ph-link is-live"><i />Live</span>;
  return <button className={"ph-link is-" + link} onClick={retry} aria-label="Reconnect to your Mac"><i />{link === "connecting" ? "Connecting" : "Mac offline"}</button>;
}

/** While the Mac can't be reached: why, and a way to try now instead of waiting. */
function Offline({ link, retry }: { link: Link; retry: () => void }) {
  if (link !== "offline") return null;
  return (
    <div className="ph-offline" role="status">
      <div><strong>Can't reach your Mac</strong><span>Open Desk on your Mac with the phone remote on. This reconnects by itself.</span></div>
      <button className="ph-again" onClick={retry}>Try again</button>
    </div>
  );
}

function StateMark({ s, now }: { s: PhoneSession; now: number }) {
  if (s.state === "waiting") return <span className="ph-state is-waiting">Needs you</span>;
  if (s.state === "working") return <span className="ph-state is-working"><LoaderCircle size={12} className="ph-spin" />{s.since ? elapsed(s.since, now) : "Working"}</span>;
  if (s.state === "done") return <span className="ph-state is-done"><i />{ago(s.updated, now)}</span>;
  return <span className="ph-state">{ago(s.updated, now)}</span>;
}

function Avatar({ s }: { s: PhoneSession }) {
  return (
    <span className="ph-avatar">
      <ToolLogo tool={s.tool} size={20} />
      {s.where.provider !== "mac" && <span className="ph-avatar-where"><SandboxLogo provider={s.where.provider} size={11} /></span>}
    </span>
  );
}

function SessionRow({ s, now, onOpen, act }: { s: PhoneSession; now: number; onOpen: () => void; act: (a: PhoneAction) => Promise<void> }) {
  const [answered, setAnswered] = useState<"Allowed" | "Denied" | null>(null);
  const answer = (allow: boolean) => {
    if (!s.approval) return;
    tap();
    setAnswered(allow ? "Allowed" : "Denied");
    void act({ type: "answer", id: s.id, requestId: s.approval.requestId, allow }).catch(() => setAnswered(null));
  };
  return (
    <div className={"ph-row is-" + s.state}>
      <button className="ph-row-main" onClick={onOpen}>
        <Avatar s={s} />
        <span className="ph-row-text">
          <span className="ph-row-top"><strong>{s.title}</strong><StateMark s={s} now={now} /></span>
          <span className="ph-row-sub">{s.activity || `${AGENT[s.tool] ?? s.tool}${s.kind === "terminal" ? " · terminal" : ""}`}</span>
        </span>
        <ChevronRight size={16} className="ph-row-chev" />
      </button>
      {s.approval && (
        <div className="ph-row-ask">
          <code>{s.approval.plan ? "Plan ready to go" : `${s.approval.tool}: ${s.approval.summary}`}</code>
          {answered ? <span className="ph-answered">{answered}</span> : (
            <span className="ph-ask-btns">
              <button className="ph-btn" onClick={() => answer(false)}>Deny</button>
              {s.approval.allowOnce ? <button className="ph-btn is-primary" onClick={() => answer(true)}>{s.approval.plan ? "Approve" : "Allow once"}</button> : <span className="ph-note">Answer in Desk</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ListScreen({ feed, link, onOpen, act, retry }: { feed: PhonePayload; link: Link; onOpen: (id: string) => void; act: (a: PhoneAction) => Promise<void>; retry: () => void }) {
  const now = useNow(5000);
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const q = query.trim().toLowerCase();
  const list = q ? feed.sessions.filter((s) => `${s.title} ${s.project} ${s.activity} ${AGENT[s.tool]}`.toLowerCase().includes(q)) : feed.sessions;
  const needs = list.filter((s) => s.state === "waiting");
  const groups = useMemo(() => {
    const by = new Map<string, { name: string; items: PhoneSession[] }>();
    for (const s of list) {
      if (s.state === "waiting") continue;
      const g = by.get(s.projectId) ?? { name: s.project, items: [] };
      g.items.push(s);
      by.set(s.projectId, g);
    }
    return [...by.values()];
  }, [list]);
  const working = feed.sessions.filter((s) => s.state === "working").length;
  return (
    <section className="ph-screen ph-list" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 28)}>
      <header className={"ph-bar" + (scrolled ? " is-scrolled" : "")}>
        <span className="ph-bar-title">Desk</span>
        <LinkPill link={link} retry={retry} />
      </header>
      <div className="ph-hero">
        <h1>Desk</h1>
        <p>{feed.sessions.length ? `${feed.sessions.length} open${working ? ` · ${working} working` : ""}${needs.length ? ` · ${needs.length} need${needs.length === 1 ? "s" : ""} you` : ""}` : link === "live" ? "Nothing open on your Mac" : "Reaching your Mac…"}</p>
        {feed.usage.length > 0 && (
          <div className="ph-usage">{feed.usage.map((u) => <span key={u.account}><UsageRing used={u.used} color={u.color} size={16} />{u.name}<b>{Math.round(u.used)}%</b></span>)}</div>
        )}
        <Offline link={link} retry={retry} />
        <label className="ph-search"><Search size={15} /><input type="search" placeholder="Search chats and tabs" value={query} onChange={(e) => setQuery(e.target.value)} enterKeyHint="search" /></label>
      </div>
      {needs.length > 0 && (
        <div className="ph-group is-needs">
          <h2><i />Needs you</h2>
          <div className="ph-card">{needs.map((s) => <SessionRow key={s.id} s={s} now={now} onOpen={() => onOpen(s.id)} act={act} />)}</div>
        </div>
      )}
      {groups.map((g) => (
        <div className="ph-group" key={g.name + g.items[0].id}>
          <h2>{g.name}</h2>
          <div className="ph-card">{g.items.map((s) => <SessionRow key={s.id} s={s} now={now} onOpen={() => onOpen(s.id)} act={act} />)}</div>
        </div>
      ))}
      {!list.length && link === "live" && (
        <div className="ph-none">{q ? "Nothing matches." : "Start a chat or an agent tab in Desk on your Mac, and it shows up here."}</div>
      )}
      <div className="ph-pad" />
    </section>
  );
}

// A conversation

/** Tool steps in a row fold into one line: "Read, Edit, Bash · 5 steps". */
type Block = { kind: "entry"; entry: PhoneEntry } | { kind: "steps"; id: string; steps: Extract<PhoneEntry, { kind: "tool" }>[] };

function blocks(entries: PhoneEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    if (e.kind === "approval" && e.state === "pending") continue; // pinned above the composer instead
    if (e.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(e);
      else out.push({ kind: "steps", id: e.id, steps: [e] });
    } else out.push({ kind: "entry", entry: e });
  }
  return out;
}

function Steps({ steps, live }: { steps: Extract<PhoneEntry, { kind: "tool" }>[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = steps.find((s) => s.state === "running");
  const failed = steps.filter((s) => s.state === "error").length;
  const names = [...new Set(steps.map((s) => s.name))].slice(0, 3).join(", ");
  return (
    <div className={"ph-steps" + (open ? " is-open" : "")}>
      <button className="ph-steps-head" onClick={() => { tap(); setOpen(!open); }}>
        {running && live ? <LoaderCircle size={13} className="ph-spin" /> : failed ? <X size={13} className="is-bad" /> : <Check size={13} className="is-ok" />}
        <span className="ph-steps-label">{running && live ? <><b>{running.name}</b> {running.summary}</> : <>{names}{steps.length > 1 ? ` · ${steps.length} steps` : steps[0].summary ? ` · ${steps[0].summary}` : ""}</>}</span>
        <ChevronRight size={14} className="ph-steps-chev" />
      </button>
      <div className="ph-steps-body">
        <div>
          {steps.map((s) => (
            <div key={s.id} className={"ph-step is-" + s.state}>
              <span className="ph-step-head"><b>{s.name}</b><span>{s.summary}</span></span>
              {s.output && <pre>{s.output}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Entry({ e }: { e: PhoneEntry }) {
  switch (e.kind) {
    case "user":
      return <div className="ph-msg is-user"><div className="ph-bubble">{e.text}{e.files?.length ? <span className="ph-files">{e.files.join(", ")}</span> : null}</div></div>;
    case "assistant":
      return <div className={"ph-msg is-agent" + (e.streaming ? " is-streaming" : "")}><Markdown text={e.text || " "} /></div>;
    case "approval":
      return <div className="ph-notice">{e.state === "allowed" ? "Allowed" : e.state === "denied" ? "Denied" : "Expired"}: {e.tool} {e.summary.split("\n")[0]}</div>;
    case "notice":
      return <div className={"ph-notice" + (e.tone === "error" ? " is-error" : "")}>{e.text}</div>;
    default:
      return null;
  }
}

function Composer({ s, act, onSent }: { s: PhoneSession; act: (a: PhoneAction) => Promise<void>; onSent: (text: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  const busy = s.state === "working" || s.state === "waiting";
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    tap();
    setText("");
    onSent(t);
    void act({ type: "reply", id: s.id, text: t }).catch(() => setText(t));
  };
  if (!s.canReply) return null;
  return (
    <div className="ph-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={s.kind === "terminal" ? `Type to ${AGENT[s.tool] ?? "the agent"}` : busy ? "Queued until this turn ends" : `Reply to ${AGENT[s.tool] ?? "the agent"}`}
        onChange={(e) => setText(e.target.value)}
        enterKeyHint="send"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); submit(); } }}
      />
      {s.canStop && !text.trim()
        ? <button className="ph-send is-stop" aria-label="Stop" onClick={() => { tap(); void act({ type: "stop", id: s.id }); }}><Square size={13} fill="currentColor" /></button>
        : <button className="ph-send" aria-label="Send" disabled={!text.trim()} onClick={submit}><ArrowUp size={18} strokeWidth={2.4} /></button>}
    </div>
  );
}

function Pinned({ s, act }: { s: PhoneSession; act: (a: PhoneAction) => Promise<void> }) {
  const [answered, setAnswered] = useState<string | null>(null);
  const a = s.approval!;
  useEffect(() => setAnswered(null), [a.requestId]);
  const answer = (allow: boolean) => {
    tap();
    setAnswered(allow ? "Allowed" : "Denied");
    void act({ type: "answer", id: s.id, requestId: a.requestId, allow }).catch(() => setAnswered(null));
  };
  return (
    <div className="ph-pinned">
      <div className="ph-pinned-head"><span className="ph-pinned-dot" />{a.plan ? `${AGENT[s.tool]} has a plan` : `${AGENT[s.tool]} wants to use ${a.tool}`}</div>
      <pre className="ph-pinned-cmd">{a.summary}</pre>
      {answered ? <div className="ph-answered">{answered}</div> : (
        <div className="ph-pinned-btns">
          <button className="ph-btn is-wide" onClick={() => answer(false)}>{a.plan ? "Keep planning" : "Deny"}</button>
          {a.allowOnce ? <button className="ph-btn is-wide is-primary" onClick={() => answer(true)}>{a.plan ? "Approve" : "Allow once"}</button> : <span className="ph-note">Only "always" is offered; answer in Desk.</span>}
        </div>
      )}
    </div>
  );
}

function ThreadScreen({ id, session, thread, leaving, link, retry, onBack, act }: {
  id: string;
  session: PhoneSession | null;
  thread: PhoneThread | null;
  leaving: boolean;
  link: Link;
  retry: () => void;
  onBack: () => void;
  act: (a: PhoneAction) => Promise<void>;
}) {
  const now = useNow(1000);
  const scroller = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [pending, setPending] = useState<{ text: string; at: number }[]>([]);
  const [shown, setShown] = useState(false);

  // Ask Desk for this conversation, and keep asking while it's open.
  useEffect(() => {
    if (leaving) return;
    const watch = () => void act({ type: "watch", id }).catch(() => {});
    watch();
    const t = setInterval(watch, 20_000);
    void act({ type: "seen", id }).catch(() => {});
    return () => clearInterval(t);
  }, [id, leaving, act, link === "live"]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);

  const entries = thread?.kind === "chat" ? thread.entries : [];
  // A reply shows at once; it's replaced when Desk sends it back as part of the chat.
  useEffect(() => {
    setPending((p) => p.filter((x) => Date.now() - x.at < 15_000 && !entries.slice(-6).some((e) => e.kind === "user" && e.text === x.text)));
  }, [entries]);
  const list = useMemo(() => blocks(entries), [entries]);
  const sig = `${entries.length}:${entries[entries.length - 1]?.kind === "assistant" ? (entries[entries.length - 1] as { text: string }).text.length : 0}:${pending.length}:${thread?.kind === "terminal" ? thread.screen.length : 0}`;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stuck) el.scrollTop = el.scrollHeight;
    else setFresh(true);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // First load lands at the bottom.
  useLayoutEffect(() => { const el = scroller.current; if (el && thread) el.scrollTop = el.scrollHeight; }, [!!thread]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStuck(atBottom);
    if (atBottom) setFresh(false);
  };
  const toBottom = () => { tap(); const el = scroller.current!; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); setFresh(false); };

  // Swipe from the left edge to go back, like any iPhone app.
  const drag = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; if (t.clientX < 28) drag.current = { x: t.clientX, y: t.clientY, dx: 0, on: false }; };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = e.touches[0];
    const dx = t.clientX - d.x;
    if (!d.on && Math.abs(t.clientY - d.y) > Math.abs(dx)) { drag.current = null; return; }
    d.on = dx > 6;
    d.dx = Math.max(0, dx);
    if (screen.current) { screen.current.style.transition = "none"; screen.current.style.transform = `translateX(${d.dx}px)`; }
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !screen.current) return;
    screen.current.style.transition = "";
    screen.current.style.transform = "";
    if (d.dx > window.innerWidth * 0.3) onBack();
  };

  const s = session;
  const title = s?.title ?? "Closed";
  return (
    <section
      ref={screen}
      className={"ph-screen ph-thread" + (shown && !leaving ? " is-in" : "")}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <header className="ph-bar is-thread">
        <button className="ph-back" onClick={() => { tap(); onBack(); }} aria-label="Back"><ChevronLeft size={24} strokeWidth={2.2} /><span>Desk</span></button>
        <div className="ph-bar-mid">
          <strong>{title}</strong>
          {s && <span>{AGENT[s.tool] ?? s.tool} · {s.where.provider === "mac" ? s.project : s.where.label}</span>}
        </div>
        <span className="ph-bar-right">{s && <StateMark s={s} now={now} />}</span>
      </header>
      {link !== "live" && <div className="ph-banner">{link === "offline" ? <>Mac offline. Reconnecting… <button className="ph-banner-btn" onClick={retry}>Try again</button></> : "Connecting…"}</div>}
      <div className="ph-scroll" ref={scroller} onScroll={onScroll}>
        {!s && <div className="ph-none">This was closed in Desk.</div>}
        {s && !thread && <div className="ph-loading"><LoaderCircle size={18} className="ph-spin" />Loading the conversation…</div>}
        {thread?.kind === "chat" && (
          <div className="ph-thread-body">
            {thread.truncated && <div className="ph-notice">Earlier messages are on your Mac.</div>}
            {list.map((b, i) => b.kind === "steps" ? <Steps key={b.id} steps={b.steps} live={i === list.length - 1 && s?.state === "working"} /> : <Entry key={b.entry.id} e={b.entry} />)}
            {pending.map((p) => <div key={p.at} className="ph-msg is-user is-pending"><div className="ph-bubble">{p.text}</div></div>)}
            {s?.state === "working" && entries[entries.length - 1]?.kind !== "assistant" && entries[entries.length - 1]?.kind !== "tool" && <div className="ph-typing"><i /><i /><i /></div>}
            {(s?.queued ?? 0) > 0 && <div className="ph-notice">{s!.queued} message{s!.queued === 1 ? "" : "s"} waiting for this turn to end</div>}
          </div>
        )}
        {thread?.kind === "terminal" && <pre className="ph-term">{thread.screen || " "}</pre>}
      </div>
      {fresh && !stuck && <button className="ph-jump" onClick={toBottom} aria-label="Newest"><ArrowDown size={16} /></button>}
      <footer className="ph-foot">
        {s?.approval && <Pinned s={s} act={act} />}
        {s && <Composer s={s} act={act} onSent={(text) => { setPending((p) => [...p, { text, at: Date.now() }]); setStuck(true); }} />}
      </footer>
    </section>
  );
}
