import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const HOME = os.homedir();
const BASE = 'http://127.0.0.1:4737';
const src = path.join(HOME, '.config/opencode/agents/image-finder.md');
const orig = fs.readFileSync(src, 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-v1-'));
const dir = path.join(tmp, 'demo/.opencode/agents');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'image-finder.md');
fs.writeFileSync(target, orig);

function req(p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const state = await req('/api/state?root=' + encodeURIComponent(tmp));
const agent = state.body.projects[0].agents[0];
assert.deepStrictEqual(agent.v1, ['permission'], 'v1 detected');

const body = agent.prompt;
const saved = await req('/api/save', {
  root: tmp,
  file: target,
  mtime: agent.mtime,
  fields: { description: agent.fields.description, mode: 'subagent', steps: 6, color: '#ff6b6b' },
  prompt: body,
});
assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

const after = fs.readFileSync(target, 'utf8');
const permissionBlock = (t) => {
  const m = /^permission:\n(?:[ \t].*\n?)*/m.exec(t);
  return m ? m[0] : null;
};
assert.strictEqual(permissionBlock(after), permissionBlock(orig), 'V1 permission block kept verbatim');
assert.ok(after.indexOf('steps: 6') >= 0 && after.indexOf('color:') >= 0, 'new fields written');
assert.strictEqual(after.replace(/^---\n[\s\S]*?\n---\n\n?/, '').trim(), orig.replace(/^---\n[\s\S]*?\n---\n\n?/, '').trim(), 'prompt body untouched');

console.log('v1 file: save keeps permission block verbatim, prompt untouched');
console.log(after.split('\n---\n')[0]);
fs.rmSync(tmp, { recursive: true, force: true });
