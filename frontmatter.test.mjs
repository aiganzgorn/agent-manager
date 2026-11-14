import assert from 'assert';
import { parseAgentFile, stringifyAgentFile } from './frontmatter.mjs';

// 1. Plain V2 agent: frontmatter + prompt body.
const v2 = `---
description: Reviews changes for correctness
mode: subagent
model: anthropic/claude-sonnet-5-5#high
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: read
    resource: src/**
    effect: allow
---

Review the current changes.
`;
const a = parseAgentFile(v2);
assert.strictEqual(a.fields.description, 'Reviews changes for correctness');
assert.strictEqual(a.fields.mode, 'subagent');
assert.strictEqual(a.fields.model, 'anthropic/claude-sonnet-5-5#high');
assert.deepStrictEqual(a.fields.permissions, [
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'read', resource: 'src/**', effect: 'allow' },
]);
assert.strictEqual(a.prompt, 'Review the current changes.');

const back = stringifyAgentFile(a.fields, a.extra, a.prompt);
const a2 = parseAgentFile(back);
assert.deepStrictEqual(a2.fields, a.fields);
assert.strictEqual(a2.prompt, a.prompt);

// 2. V1 file: permission map and other unknown keys must survive a save.
const v1 = `---
description: Finds images
mode: subagent
permission:
  edit: deny
  bash:
    "*": deny
    "curl *": allow
---
Body here.
`;
const b = parseAgentFile(v1);
assert.strictEqual(b.fields.description, 'Finds images');
assert.strictEqual(b.fields.permission, undefined);
assert.ok(b.extra.indexOf('permission:') >= 0, 'V1 permission block preserved');
assert.ok(b.extra.indexOf('"curl *": allow') >= 0, 'nested V1 rules preserved');
const v1Back = stringifyAgentFile({ ...b.fields, steps: 4, hidden: true }, b.extra, b.prompt);
assert.ok(v1Back.indexOf('steps: 4') >= 0);
assert.ok(v1Back.indexOf('hidden: true') >= 0);
assert.ok(v1Back.indexOf('permission:') >= 0);
assert.strictEqual(parseAgentFile(v1Back).fields.permission, undefined);
assert.strictEqual(parseAgentFile(v1Back).extra.trim(), b.extra.trim());

// 3. Block scalar description and one-line list of scalars.
const c = parseAgentFile(`---
description: |
  Multi line
  description
steps: 8
color: "#ff6b6b"
permissions:
  - shell
  - edit
---
`);
assert.strictEqual(c.fields.description, 'Multi line\ndescription');
assert.strictEqual(c.fields.steps, 8);
assert.strictEqual(c.fields.color, '#ff6b6b');
assert.deepStrictEqual(c.fields.permissions, ['shell', 'edit']);

// 4. No frontmatter (docs-style file) stays a plain body.
const d = parseAgentFile('Just a prompt.\n');
assert.deepStrictEqual(d.fields, {});
assert.strictEqual(d.prompt, 'Just a prompt.\n');
assert.ok(stringifyAgentFile({ mode: 'primary' }, '', 'Hi').indexOf('mode: primary') > -1);

// 5. Values that need quoting stay readable after a round trip.
const tricky = { description: "Don't break: it's #1", model: 'a/b#high', color: '#ff6b6b' };
const t = parseAgentFile(stringifyAgentFile(tricky, '', ''));
assert.deepStrictEqual(t.fields, tricky);

console.log('frontmatter: all checks passed');
