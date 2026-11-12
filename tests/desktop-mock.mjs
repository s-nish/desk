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
      if (cmd === 'accounts_detect') return JSON.parse(localStorage.getItem('test-detected') || '[]');
      if (cmd === 'account_usage') return [];
      if (cmd === 'tool_installed') return (args.bins || []).some((b) => ['claude', 'codex'].includes(b));
      if (cmd === 'account_create') return `/demo/.${args.kind}-${args.name.toLowerCase()}`;
      if (cmd === 'usage_limits') {
        const soon = Date.now() + 72 * 60000, week = Date.now() + 3 * 86400000;
        return JSON.parse(localStorage.getItem('test-limits') || 'null') ?? [
          { tool: 'claude', dir: null, session: { used: 42, resetsAt: soon, minutes: 300 }, weekly: { used: 16, resetsAt: week, minutes: 10080 }, plan: null, updated: Date.now() - 120000 },
          { tool: 'codex', dir: null, session: { used: 91, resetsAt: soon, minutes: 300 }, weekly: { used: 23, resetsAt: week, minutes: 10080 }, plan: 'plus', updated: Date.now() - 600000 },
        ];
      }
      // Phone remote: Tailscale up; Serve not allowed on the tailnet until the second try.
      if (cmd === 'remote_status') return { port: 47821, page: true, devices: [] };
      if (cmd === 'remote_log') return [];
      if (cmd === 'remote_tailscale') return { installed: true, running: true, url: 'https://mac.tail0.ts.net', detail: 'Connected to your tailnet.' };
      if (cmd === 'remote_enable') return;
      if (cmd === 'remote_serve') { if (args.on && !window.serveTries) { window.serveTries = 1; throw 'ENABLE https://login.tailscale.com/f/serve?node=x'; } return; }
      if (cmd === 'remote_pair') return 'code123';
      if (cmd === 'remote_qr') return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
      if (cmd === 'claude_limits_hook') return { settings: '/demo/Library/Application Support/Desk/limits/claude.settings.json', env: { DESK_LIMITS_FILE: '/demo/limits.json' } };
      if (cmd === 'pty_set_background') return;
      if (cmd === 'fs_list_dir') return [{ name: 'a.ts', path: '/demo/studio/a.ts', isDir: false, ignored: false }, { name: 'b.ts', path: '/demo/studio/b.ts', isDir: false, ignored: false }];
      if (cmd === 'fs_list_files') return ['a.ts', 'b.ts'];
      if (cmd === 'plugin:path|resolve_directory') return '/demo';
      if (cmd === 'git_branch') return 'main';
      if (cmd === 'chat_spawn') {
        // A reviewer: answers once with a finding on a.ts line 1.
        const id = 900 + window.testCalls.filter((c) => c.cmd === 'chat_spawn').length;
        const channel = window.testCallbacks.get(args.onLine.id);
        const finding = JSON.stringify([{ file: 'a.ts', line: 1, severity: 'high', title: 'Renamed without callers', body: 'Update the two imports too.' }]);
        const lines = [{ type: 'item.completed', item: { type: 'agent_message', text: '```json\n' + finding + '\n```' } }, { type: 'desk_exit', code: 0, stderr: '' }];
        setTimeout(() => lines.forEach((l, index) => channel?.({ index, message: JSON.stringify(l) })), 300);
        return id;
      }
      if (cmd === 'sandbox_run') {
        // localStorage test-sandbox: "docker" has Docker installed but closed until `open -a Docker`.
        const a = args.opts.args;
        if (localStorage.getItem('test-sandbox') === 'docker' && a[0] === 'docker') {
          if (a[1] === 'info') return window.dockerUp ? { code: 0, stdout: 'Docker 29.8.2\n', stderr: '' } : { code: 1, stdout: '', stderr: 'failed to connect to the docker API at unix:///demo/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /demo/.docker/run/docker.sock: connect: no such file or directory' };
          if (a[1] === 'context') return { code: 0, stdout: 'desktop-linux\n', stderr: '' };
        }
        if (localStorage.getItem('test-sandbox') === 'docker' && a[0] === 'open') { setTimeout(() => { window.dockerUp = true; }, 300); return { code: 0, stdout: '', stderr: '' }; }
        return { code: 127, stdout: '', stderr: 'zsh:1: command not found: ' + a[0] };
      }
      if (cmd === 'sandbox_secret_has') return false;
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
