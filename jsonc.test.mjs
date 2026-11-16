import assert from 'assert';
import { parseConfig, topLevelEntries, setTopLevelValue, valueKind, toLiteral } from './jsonc.mjs';

const src = `{
  "$schema": "https://opencode.ai/config.json",
  // keep me: default model
  "model": "opencode/deepseek-v4-flash-free",
  "default_agent": "chan",
  "compaction": { "auto": false, "prune": false },
  "nested": { "model": "should-not-be-seen" },
  "note": "braces } and commas , inside a string",
  "count": 3,
  "flag": true,
  "z": [1, 2, {"k": "v"}]
}
`;

const keys = topLevelEntries(src).map((e) => e.key);
assert.deepStrictEqual(keys, ['$schema', 'model', 'default_agent', 'compaction', 'nested', 'note', 'count', 'flag', 'z']);

const byKey = (k) => topLevelEntries(src).filter((e) => e.key === k)[0];
assert.strictEqual(byKey('model').value, '"opencode/deepseek-v4-flash-free"');
assert.strictEqual(valueKind(byKey('model').value), 'string');
assert.strictEqual(valueKind(byKey('count').value), 'number');
assert.strictEqual(valueKind(byKey('flag').value), 'boolean');
assert.strictEqual(valueKind(byKey('compaction').value), 'complex');
assert.strictEqual(valueKind(byKey('note').value), 'string');

// Replace a string value: comments, ordering and other keys untouched.
const replaced = setTopLevelValue(src, 'model', '"anthropic/claude-sonnet-5-5"');
assert.strictEqual(parseConfig(replaced).model, 'anthropic/claude-sonnet-5-5');
assert.ok(replaced.indexOf('// keep me: default model') > -1);
assert.deepStrictEqual(
  topLevelEntries(replaced).map((e) => e.key),
  keys
);
const beforeLines = src.split('\n').filter((l) => l.indexOf('// keep me') > -1);
const afterLines = replaced.split('\n').filter((l) => l.indexOf('// keep me') > -1);
assert.deepStrictEqual(afterLines, beforeLines);

// Replace an object with a scalar and a scalar with an object keep the file valid.
assert.strictEqual(parseConfig(setTopLevelValue(src, 'compaction', 'false')).compaction, false);
assert.deepStrictEqual(parseConfig(setTopLevelValue(src, 'count', '{ "a": 1 }')).count, { a: 1 });

// Adding a missing key appends before the closing brace with a comma.
const added = setTopLevelValue(src, 'small_model', '"lmstudio/qwen2.5-coder-7b-instruct-mlx"');
const addedCfg = parseConfig(added);
assert.strictEqual(addedCfg.small_model, 'lmstudio/qwen2.5-coder-7b-instruct-mlx');
assert.strictEqual(addedCfg.model, 'opencode/deepseek-v4-flash-free');
assert.deepStrictEqual(Object.keys(addedCfg), keys.concat(['small_model']));
assert.ok(added.indexOf('// keep me') > -1);

// Adding to an empty object needs no leading comma.
const empty = setTopLevelValue('{\n}\n', 'model', '"x/y"');
assert.deepStrictEqual(parseConfig(empty), { model: 'x/y' });

// A file that already has a trailing comma stays valid.
const trailing = '{\n  "model": "a/b",\n}\n';
assert.deepStrictEqual(parseConfig(setTopLevelValue(trailing, 'default_agent', '"plan"')), {
  model: 'a/b',
  default_agent: 'plan',
});

// Strings that look like structure do not confuse the scanner.
assert.strictEqual(parseConfig(`{"note": "a } b , c", "model": "x/y"}`).model, 'x/y');

// Literals
assert.strictEqual(toLiteral("it's"), '"it\'s"');
assert.strictEqual(toLiteral(5), '5');
assert.strictEqual(toLiteral(false), 'false');
assert.strictEqual(toLiteral(null), 'null');

console.log('jsonc: all checks passed');
