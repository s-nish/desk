import { useEffect } from "react";
import {
  ChevronRight,
  Copy,
  File,
  FileCode,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Image,
  ListCollapse,
  Pencil,
  SquareTerminal,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { useDesk, focusedTabId } from "../store";
import { useTree } from "../tree";
import { activeTab, confirmTrash, openFile, openTerminal, promptNewFile, promptRename } from "../actions";
import { renameEditorPath } from "../editors";
import { pasteIntoTerminal } from "../terminals";
import { ipc } from "../ipc";
import { openMenu } from "./Menu";
import type { DirEntry, MenuItem, Project } from "../types";

const CODE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "vue", "svelte", "html", "css", "scss", "sql", "lua", "zig"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "icns"]);

function FileIcon({ name }: { name: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const props = { size: 14, className: "node-icon" };
  if (ext === "json" || ext === "lock") return <FileJson {...props} />;
  if (ext === "md" || ext === "txt" || ext === "mdx") return <FileText {...props} />;
  if (IMAGE.has(ext)) return <Image {...props} />;
  if (CODE.has(ext)) return <FileCode {...props} />;
  return <File {...props} />;
}

export function FilesPanel() {
  const project = useDesk((s) => s.projects.find((p) => p.id === s.activeProjectId));
  if (!project) return <aside className="files" />;
  return <FilesFor key={project.id} project={project} />;
}

function FilesFor({ project }: { project: Project }) {
  const load = useTree((s) => s.load);
  const rootEntries = useTree((s) => s.children[project.path]);
  const rootError = useTree((s) => s.errors[project.path]);

  useEffect(() => {
    void load(project.path);
  }, [project.path, load]);

  const collapseAll = () =>
    useTree.setState((s) => ({
      expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.startsWith(project.path + "/"))),
    }));

  return (
    <aside className="files">
      <header className="side-header">
        <h2 title={project.path}>Files</h2>
        <div className="side-actions">
          <button className="icon-btn" title="New file" aria-label="New file" onClick={() => promptNewFile(project.id, project.path, false)}>
            <FilePlus size={14} />
          </button>
          <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => promptNewFile(project.id, project.path, true)}>
            <FolderPlus size={14} />
          </button>
          <button className="icon-btn" title="Collapse folders" aria-label="Collapse folders" onClick={collapseAll}>
            <ListCollapse size={14} />
          </button>
        </div>
      </header>
      <div
        className="tree side-scroll"
        role="tree"
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY }, [
            { label: "New file…", icon: <FilePlus size={14} />, onSelect: () => promptNewFile(project.id, project.path, false) },
            { label: "New folder…", icon: <FolderPlus size={14} />, onSelect: () => promptNewFile(project.id, project.path, true) },
          ]);
        }}
      >
        {rootError && <p className="tree-note">{rootError}</p>}
        {rootEntries?.map((e) => <Node key={e.path} entry={e} depth={0} project={project} />)}
        {rootEntries?.length === 0 && <p className="tree-note">This folder is empty.</p>}
      </div>
    </aside>
  );
}

function nodeMenu(entry: DirEntry, project: Project): MenuItem[] {
  const dir = entry.isDir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf("/"));
  const rel = entry.path.startsWith(project.path + "/") ? entry.path.slice(project.path.length + 1) : entry.path;
  const term = activeTab();
  const items: MenuItem[] = [
    { label: "New file…", icon: <FilePlus size={14} />, onSelect: () => promptNewFile(project.id, dir, false) },
    { label: "New folder…", icon: <FolderPlus size={14} />, onSelect: () => promptNewFile(project.id, dir, true) },
    { separator: true },
    {
      label: "Rename…",
      icon: <Pencil size={14} />,
      onSelect: () =>
        promptRename(entry.path, (to) => {
          renameEditorPath(entry.path, to);
          for (const t of useDesk.getState().tabs) {
            if (t.type === "file" && (t.path === entry.path || t.path.startsWith(entry.path + "/"))) {
              const path = to + t.path.slice(entry.path.length);
              useDesk.getState().patchTab(t.id, { path, title: path.split("/").pop()! });
            }
          }
        }),
    },
    { label: "Copy path", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(entry.path) },
    { label: "Copy relative path", icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(rel) },
  ];
  if (term?.type === "terminal" && term.projectId === project.id) {
    items.push({
      label: "Mention in terminal",
      hint: "@path",
      icon: <TextCursorInput size={14} />,
      onSelect: () => pasteIntoTerminal(term.id, `@${rel}${entry.isDir ? "/" : ""} `),
    });
  }
  items.push(
    { label: "Open shell here", icon: <SquareTerminal size={14} />, onSelect: () => openTerminal(project.id, "shell", { cwd: dir }) },
    { label: "Reveal in Finder", icon: <FolderSearch size={14} />, onSelect: () => void ipc.reveal(entry.path) },
    { separator: true },
    { label: "Move to Trash", icon: <Trash2 size={14} />, danger: true, onSelect: () => confirmTrash(entry.path) },
  );
  return items;
}

function Node({ entry, depth, project }: { entry: DirEntry; depth: number; project: Project }) {
  const expanded = useTree((s) => !!s.expanded[entry.path]);
  const children = useTree((s) => (entry.isDir ? s.children[entry.path] : undefined));
  const toggle = useTree((s) => s.toggle);
  const selected = useDesk((s) => {
    const t = s.tabs.find((x) => x.id === focusedTabId(s));
    return t?.type === "file" && t.path === entry.path;
  });

  const activate = () => (entry.isDir ? toggle(entry.path) : void openFile(project.id, entry.path));

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={entry.isDir ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        className={"node" + (selected ? " is-selected" : "") + (entry.ignored ? " is-ignored" : "")}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY }, nodeMenu(entry, project));
        }}
        title={entry.path}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData("desk/path", entry.path); e.dataTransfer.setData("text/plain", entry.path); e.dataTransfer.effectAllowed = "copy"; }}
      >
        {entry.isDir ? (
          <>
            <ChevronRight size={13} className={"node-chevron" + (expanded ? " is-open" : "")} />
            {expanded ? <FolderOpen size={14} className="node-icon is-dir" /> : <Folder size={14} className="node-icon is-dir" />}
          </>
        ) : (
          <>
            <span className="node-chevron-space" />
            <FileIcon name={entry.name} />
          </>
        )}
        <span className="node-name">{entry.name}</span>
      </div>
      {entry.isDir && expanded && children?.map((c) => <Node key={c.path} entry={c} depth={depth + 1} project={project} />)}
    </>
  );
}
