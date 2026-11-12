// A stand-in coding agent: prints a hello, answers each input line, and exits on "bye".
import { createInterface } from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ type: 'hello', env: process.env.DESK_FAKE ?? null, cwd: process.cwd(), gone: process.env.DESK_GONE ?? null });
if (process.argv.includes('--count')) {
  for (let i = 0; i < 5; i++) { say({ type: 'tick', i }); await new Promise((r) => setTimeout(r, 300)); }
  process.stderr.write('done "counting"\n');
  process.exit(3);
}
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.text === 'bye') { say({ type: 'bye' }); process.exit(0); }
  if (msg.text === 'slow') { for (let i = 0; i < 4; i++) { say({ type: 'step', i }); await new Promise((r) => setTimeout(r, 400)); } }
  say({ type: 'echo', text: msg.text });
}
