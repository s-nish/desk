// Desk on your phone: the notch's feed, full screen, over your tailnet. It can
// allow (once), deny, reply and stop; nothing else. Served by remote.rs.

import { useEffect, useMemo, useState } from "react";
import { ApprovalCard } from "../feedui/ApprovalCard";
import { ReplyField } from "../feedui/ReplyField";
import { Row } from "../feedui/Row";
import { UsageRing } from "../feedui/UsageRing";
import type { FeedAction, FeedItem, NotchUsage } from "../notch/protocol";

interface Feed { items: FeedItem[]; usage: NotchUsage[] }

type Link = "connecting" | "live" | "offline" | "unpaired";

async function post(action: FeedAction) {
  const res = await fetch("/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action), credentials: "same-origin" });
  if (!res.ok) throw new Error(await res.text());
}

export function Remote() {
  const [feed, setFeed] = useState<Feed>({ items: [], usage: [] });
  const [link, setLink] = useState<Link>("connecting");
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, "Allowed" | "Declined">>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let wait = 1000;
    const connect = async () => {
      // EventSource hides the status; ask once so an unpaired phone says so.
      const probe = await fetch("/events", { method: "HEAD", credentials: "same-origin" }).catch(() => null);
      if (probe?.status === 401) { setLink("unpaired"); return; }
      source = new EventSource("/events", { withCredentials: true });
      source.onmessage = (e) => {
        try { setFeed(JSON.parse(e.data)); setLink("live"); wait = 1000; } catch { /* a ping */ }
      };
      source.onerror = () => {
        source?.close();
        setLink("offline");
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    void connect();
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const wake = () => { if (document.visibilityState === "visible") { source?.close(); if (retry) clearTimeout(retry); wait = 1000; void connect(); } };
    document.addEventListener("visibilitychange", wake);
    return () => { source?.close(); if (retry) clearTimeout(retry); clearInterval(tick); document.removeEventListener("visibilitychange", wake); };
  }, []);

  const { waiting, working, done } = useMemo(() => ({
    waiting: feed.items.filter((i) => i.state === "waiting"),
    working: feed.items.filter((i) => i.state === "working"),
    done: feed.items.filter((i) => i.state === "done"),
  }), [feed]);
  const target = feed.items.find((i) => i.id === selected && i.canReply) ?? waiting.find((i) => i.canReply) ?? null;

  const act = (action: FeedAction) => post(action).then(() => setError(""), (e) => setError(String(e.message ?? e)));
  const answer = (item: FeedItem, allow: boolean) => {
    if (!item.approval) return;
    setAnswered((a) => ({ ...a, [item.approval!.requestId]: allow ? "Allowed" : "Declined" }));
    void act({ type: "answer", id: item.id, requestId: item.approval.requestId, allow });
  };
  const nothing = () => {};

  if (link === "unpaired") {
    return <main className="remote is-empty"><h1>Not paired</h1><p>Open Desk on your Mac, go to Settings ▸ Phone, and scan the code with this phone.</p></main>;
  }

  return (
    <main className="remote">
      <header className="remote-head">
        <strong>Desk</strong>
        <span className={"remote-link is-" + link}>{link === "live" ? "Live" : link === "connecting" ? "Connecting…" : "Mac offline, retrying"}</span>
      </header>
      {error && <p className="remote-error" role="alert">{error}</p>}
      <div className="remote-list">
        {waiting.length > 0 && <div className="notch-group"><span className="notch-mark is-waiting" />Waiting for you</div>}
        {waiting.map((item) => item.approval
          ? <ApprovalCard key={item.id} item={item} answered={answered[item.approval.requestId] ?? null} selected={item.id === selected} keys={false} onAnswer={(allow) => answer(item, allow)} onSelect={() => setSelected(item.id)} />
          : <Row key={item.id} item={item} now={now} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}
        {working.length > 0 && <div className="notch-group"><span className="notch-mark is-working" />Working</div>}
        {working.map((item) => <Row key={item.id} item={item} now={now} selected={item.id === selected} onSelect={() => setSelected(item.id)} onStop={() => void act({ type: "stop", id: item.id })} />)}
        {done.length > 0 && <div className="notch-group"><span className="notch-mark is-done">✓</span>Finished</div>}
        {done.map((item) => <Row key={item.id} item={item} now={now} selected={item.id === selected} onSelect={() => setSelected(item.id)} onDismiss={() => void act({ type: "seen", id: item.id })} />)}
        {!feed.items.length && link === "live" && <p className="remote-none">No agents running. Start one in Desk and it shows up here.</p>}
      </div>
      <footer className="remote-foot">
        <ReplyField target={target} onSend={(text) => target && void act({ type: "reply", id: target.id, text })} onWantKeys={nothing} onFocusChange={nothing} />
        {feed.usage.length > 0 && <div className="notch-foot">{feed.usage.map((r) => <span key={r.account} className="notch-ring"><UsageRing used={r.used} color={r.color} />{r.name} {Math.round(r.used)}%</span>)}</div>}
      </footer>
    </main>
  );
}
