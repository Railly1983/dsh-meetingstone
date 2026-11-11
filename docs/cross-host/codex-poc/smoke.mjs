import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const messages = [req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }), req(undefined, 'notifications/initialized'), req(2, 'tools/list'), req(3, 'tools/call', { name: 'meetingstone_list_roles', arguments: {} }), req(4, 'ping'), req(5, 'missing'), req(6, 'tools/call', { name: 'meetingstone_list_roles', arguments: { write: true } }), req(7, 'tools/call', { name: 'write' }), req(8, 'tools/call', { name: 'meetingstone_list_roles', arguments: null }), null];
const input = messages.map(JSON.stringify).join('\n') + '\n{\n';
if (process.argv.includes('--requests')) { process.stdout.write(input); process.exit(0); }
const p = process.argv.includes('--verify') ? { status: 0, stderr: '', stdout: readFileSync(0, 'utf8') } : spawnSync(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { input, encoding: 'utf8', timeout: 5000 });
assert.ifError(p.error); assert.equal(p.status, 0); assert.equal(p.stderr, '');
const out = p.stdout.trim().split('\n').map(JSON.parse);
assert.deepEqual(out.map(x => x.id), [1, 2, 3, 4, 5, 6, 7, 8, null, null]); assert(out.every(x => x.jsonrpc === '2.0'));
assert.equal(out[0].result.protocolVersion, '2025-06-18'); assert.deepEqual(out[0].result.capabilities, { tools: {} });
assert.equal(out[1].result.tools.length, 1); assert.equal(out[1].result.tools[0].name, 'meetingstone_list_roles'); assert.equal(out[1].result.tools[0].annotations.readOnlyHint, true);
assert.equal(out[2].result.isError, false); assert.deepEqual(JSON.parse(out[2].result.content[0].text).roles.map(x => [x.id, x.name]), [['meetingstone_wukong', '悟空']]);
assert.deepEqual(out[3].result, {}); assert.deepEqual(out.slice(4).map(x => x.error.code), [-32601, -32602, -32602, -32602, -32600, -32700]);
console.log('PASS: handshake, silent notification, one read-only tool, call, ping, errors, EOF exit');
