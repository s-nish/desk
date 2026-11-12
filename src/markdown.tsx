import { Fragment, useMemo, useState } from "react";

// Markdown: enough for agent replies (headings, lists, code, quotes, tables, emphasis, links).
// Built as React elements, so nothing in a reply is ever run as HTML.

type LinkComponent = (props: { href: string; children: React.ReactNode }) => React.ReactNode;

const PlainLink: LinkComponent = ({ href, children }) =>
  /^https?:\/\//.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;

// The link component for the parse in progress (parsing is synchronous).
let Link: LinkComponent = PlainLink;

export function Markdown({ text, link = PlainLink }: { text: string; link?: LinkComponent }) {
  const blocks = useMemo(() => {
    Link = link;
    try { return parseBlocks(text); } finally { Link = PlainLink; }
  }, [text, link]);
  return <div className="md">{blocks}</div>;
}

function parseBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={key++} lang={fence[2]} code={body.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key++}>{parseBlocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div className="md-table" key={key++}><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody></table></div>,
      );
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: string[][] = [];
      const indent = list[1].length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= indent) items.push([m[3]]);
        else if (lines[i].trim() && (/^\s{2,}/.test(lines[i]) || m) && items.length) items[items.length - 1].push(lines[i].replace(new RegExp(`^\\s{0,${indent + 3}}`), ""));
        else if (!lines[i].trim() && i + 1 < lines.length && /^(\s+)([-*+]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i + 1]) && items.length) items[items.length - 1].push("");
        else break;
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={key++}>{items.map((body, j) => <li key={j}>{body.length === 1 ? inline(body[0]) : parseBlocks(body.join("\n"))}</li>)}</Tag>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={key++}>{para.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>);
  }
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head"><span>{lang || "text"}</span><button onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</button></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={key++}>{m[2]}</code>);
    else if (m[3] || m[4]) out.push(<strong key={key++}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5] || m[6]) out.push(<em key={key++}>{inline(m[5] ?? m[6])}</em>);
    else if (m[7]) out.push(<del key={key++}>{m[7]}</del>);
    else if (m[8]) out.push(<Link key={key++} href={m[9]}>{inline(m[8])}</Link>);
    else if (m[10]) out.push(<Link key={key++} href={m[10]}>{m[10]}</Link>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

