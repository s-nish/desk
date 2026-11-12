import { ToolLogo } from "../components/ToolLogo";
import type { FeedItem } from "../feedCore";
import { elapsed } from "../notch/protocol";

interface RowProps {
  item: FeedItem;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onStop?: () => void;
  onDismiss?: () => void;
}

/** One agent: logo, title, where, how long, and what it's doing. */
export function Row({ item, now, selected, onSelect, onOpen, onStop, onDismiss }: RowProps) {
  const time = item.state === "done" ? "" : elapsed(item.since, now);
  return (
    <div
      className={"feed-row is-" + item.state + (selected ? " is-selected" : "")}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span className="feed-row-mark" aria-hidden="true" />
      <ToolLogo tool={item.tool} size={13} />
      <span className="feed-row-main">
        <span className="feed-row-title">{item.title}</span>
        {item.activity && <span className="feed-row-activity">{item.activity}</span>}
      </span>
      <span className="feed-row-meta">
        {item.where !== "local" && <span className="feed-cloud" title={`Running in ${item.where}`}>☁</span>}
        {item.accountColor && <span className="feed-account" style={{ background: item.accountColor }} />}
        <span>{item.project}</span>
        {time && <span className="feed-time">{time}</span>}
      </span>
      <span className="feed-row-actions">
        {onStop && item.state === "working" && item.kind === "chat" && (
          <button className="feed-icon" title="Stop" aria-label={`Stop ${item.title}`} onClick={(e) => { e.stopPropagation(); onStop(); }}>■</button>
        )}
        {onDismiss && item.state === "done" && (
          <button className="feed-icon" title="Mark as seen" aria-label={`Mark ${item.title} as seen`} onClick={(e) => { e.stopPropagation(); onDismiss(); }}>✓</button>
        )}
        <button className="feed-icon" title="Open in Desk" aria-label={`Open ${item.title} in Desk`} onClick={(e) => { e.stopPropagation(); onOpen(); }}>↗</button>
      </span>
    </div>
  );
}
