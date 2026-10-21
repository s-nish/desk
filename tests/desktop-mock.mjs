export function mockDesktop() {
  let callbackId = 0;
  window.testCalls = [];
  window.testCallbacks = new Map();
  const files = JSON.parse(localStorage.getItem('test-files') || 'null') || { '/demo/studio/a.ts': 'const greeting = "hello";\n', '/demo/studio/b.ts': 'hello world\n' };
  window.testFiles = files;
  let staged = false;
  let committed = false;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: (fn) => { window.testCallbacks.set(++callbackId, fn); return callbackId; },
    unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      window.testCalls.push({ cmd, args });
      if (cmd === 'state_load') return JSON.parse(localStorage.getItem('test-state') || 'null');
      if (cmd === 'state_save') { localStorage.setItem('test-state', JSON.stringify(args.state)); return; }
      if (cmd === 'plugin:dialog|open') return ['/demo/studio'];
      if (cmd === 'accounts_detect' || cmd === 'account_usage') return [];
      if (cmd === 'fs_list_dir') return [{ name: 'a.ts', path: '/demo/studio/a.ts', isDir: false, ignored: false }, { name: 'b.ts', path: '/demo/studio/b.ts', isDir: false, ignored: false }];
      if (cmd === 'fs_list_files') return ['a.ts', 'b.ts'];
      if (cmd === 'plugin:path|resolve_directory') return '/demo';
      if (cmd === 'git_branch') return 'main';
      if (cmd === 'pty_spawn') return window.testCalls.filter((c) => c.cmd === 'pty_spawn').length;
      if (cmd === 'fs_read') { if (!(args.path in files)) throw 'File not found'; return { content: files[args.path], mtime: 1 }; }
      if (cmd === 'fs_write') { files[args.path] = args.content; localStorage.setItem('test-files', JSON.stringify(files)); return 1; }
      if (cmd === 'git_status') return { root: '/demo/studio', branch: 'main', changes: committed ? [] : [{ path: 'a.ts', originalPath: null, index: staged ? 'M' : ' ', worktree: staged ? ' ' : 'M' }] };
      if (cmd === 'git_diff') return 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
      if (cmd === 'git_stage') { staged = args.staged; return; }
      if (cmd === 'git_commit') { assertNotEmpty(args.message); committed = true; return 'Committed'; }
      if (cmd === 'project_search') {
        const results = Object.entries(files).flatMap(([path, original]) => {
          const text = args.caseSensitive ? original : original.toLowerCase();
          const query = args.caseSensitive ? args.query : args.query.toLowerCase();
          const count = text.split(query).length - 1;
          return count ? [{ path: path.replace('/demo/studio/', ''), original, count, matches: original.split('\n').flatMap((text, i) => (args.caseSensitive ? text : text.toLowerCase()).includes(query) ? [{ line: i + 1, text }] : []) }] : [];
        });
        return { files: results, truncated: false, skipped: 0 };
      }
      if (cmd === 'project_replace') {
        const modified = [];
        for (const snapshot of args.snapshots) { const path = '/demo/studio/' + snapshot.path; if (files[path] !== snapshot.original) continue; files[path] = files[path].replaceAll(args.query, args.replacement); modified.push(snapshot.path); }
        localStorage.setItem('test-files', JSON.stringify(files)); return { modified, errors: [] };
      }
      return null;
    },
  };
  function assertNotEmpty(s) { if (!s.trim()) throw 'Empty commit'; }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
