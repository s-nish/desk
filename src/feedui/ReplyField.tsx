import { useState } from "react";
import type { FeedItem } from "../feedCore";

interface ReplyProps {
  target: FeedItem | null;
  onSend: (text: string) => void;
  /** The field was clicked: the window needs the keyboard. */
  onWantKeys: () => void;
  onFocusChange: (focused: boolean) => void;
}

/** One line aimed at the selected chat. Sends now if it's idle, else queues. */
export function ReplyField({ target, onSend, onWantKeys, onFocusChange }: ReplyProps) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  if (!target) return null;
  const busy = target.state !== "done";
  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
    setNote(busy ? "Queued" : "Sent");
    setTimeout(() => setNote(null), 1600);
  };
  return (
    <div className="feed-reply">
      <input
        value={text}
        placeholder={`Reply to “${target.title}”…`}
        aria-label={`Reply to ${target.title}`}
        onMouseDown={onWantKeys}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <span className="feed-reply-hint">{note ?? "↵"}</span>
    </div>
  );
}
