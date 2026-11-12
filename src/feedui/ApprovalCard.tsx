import { useState } from "react";
import { ToolLogo } from "../components/ToolLogo";
import type { FeedItem } from "../feedCore";
import { AGENT_LABEL } from "./labels";

interface CardProps {
  item: FeedItem;
  /** Shown once you answered, until the agent moves on. */
  answered: "Allowed" | "Declined" | null;
  selected: boolean;
  keys: boolean;
  onAnswer: (allow: boolean) => void;
  onOpen: () => void;
  onSelect: () => void;
}

const LINES = 6;

/** A permission question: which tool, the full command, Allow and Deny. Never "Full access". */
export function ApprovalCard({ item, answered, selected, keys, onAnswer, onOpen, onSelect }: CardProps) {
  const [full, setFull] = useState(false);
  const approval = item.approval;
  if (!approval) return null;
  const lines = approval.summary.split("\n");
  const long = lines.length > LINES;
  const shown = full || !long ? approval.summary : lines.slice(0, LINES).join("\n");
  return (
    <div className={"feed-card" + (selected ? " is-selected" : "") + (answered ? " is-answered" : "")} onClick={onSelect}>
      <div className="feed-card-head">
        <ToolLogo tool={item.tool} size={13} />
        <span className="feed-card-title">{item.title}</span>
        <span className="feed-row-meta">
          {item.accountColor && <span className="feed-account" style={{ background: item.accountColor }} />}
          <span>{item.project}</span>
        </span>
      </div>
      <div className="feed-card-ask">
        {approval.plan ? `${AGENT_LABEL[item.tool]} has a plan ready` : <>{AGENT_LABEL[item.tool]} wants to use <b>{approval.tool}</b></>}
      </div>
      {shown && (
        <pre className={"feed-code" + (long && !full ? " is-clipped" : "")} onClick={(e) => { if (long) { e.stopPropagation(); setFull(!full); } }} title={long ? (full ? "Show less" : "Show all") : undefined}>
          {shown}
        </pre>
      )}
      <div className="feed-card-actions">
        {answered ? (
          <span className={"feed-answered is-" + answered.toLowerCase()}>{answered}</span>
        ) : (
          <>
            <button className="feed-btn" onClick={(e) => { e.stopPropagation(); onAnswer(false); }}>
              {approval.plan ? "Keep planning" : "Deny"}{keys && <kbd>⌘⌫</kbd>}
            </button>
            <button className="feed-btn is-primary" onClick={(e) => { e.stopPropagation(); onAnswer(true); }}>
              {approval.plan ? "Approve" : "Allow"}{keys && <kbd>⌘↵</kbd>}
            </button>
          </>
        )}
        <button className="feed-link" onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open ↗</button>
      </div>
    </div>
  );
}
