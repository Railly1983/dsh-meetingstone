// Offline self-check for the WorkBuddy POC.
// Verifies the MCP protocol paths (initialize / tools/list / tools/call), error
// codes, the sample agents/Skill frontmatter, mcp.json, and local README links.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

const request = (id, method, params) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

function runServer() {
  const lines = [
    JSON.stringify(
      request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'workbuddy-poc-smoke', version: '0.1.0' },
      }),
    ),
    JSON.stringify(request(undefined, 'notifications/initialized', {})),
    JSON.stringify(request(2, 'tools/list')),
    JSON.stringify(request(3, 'tools/call', { name: 'meetingstone_list_roles', arguments: {} })),
    JSON.stringify(request(4, 'ping')),
    JSON.stringify(request(5, 'missing/method')),
    JSON.stringify(
      request(6, 'tools/call', { name: 'meetingstone_list_roles', arguments: { write: true } }),
    ),
    JSON.stringify(request(7, 'tools/call', { name: 'write' })),
    JSON.stringify(
      request(8, 'tools/call', { name: 'meetingstone_list_roles', arguments: null }),
    ),
    JSON.stringify(request(9, 'tools/call', { name: 'meetingstone_list_roles', arguments: [] })),
    JSON.stringify(request(10, 'tools/call', {})),
    JSON.stringify(request(11, 'initialize', { protocolVersion: '1999-01-01' })),
    JSON.stringify(request(12, 'tools/call', { name: 'meetingstone_list_roles' })),
    JSON.stringify(request(13, 'ping', [])),
    'null',
    '{',
    '[]',
    JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }),
  ];
  const input = `${lines.join('\n')}\n`;
  const result = spawnSync(process.execPath, [SERVER], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `server exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, '', 'server must not write to stderr during normal runs');
  const output = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return output;
}

function parseFrontMatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  assert.ok(normalized.startsWith('---\n'), 'frontmatter must start on line 1');
  const end = normalized.indexOf('\n---\n', 4);
  assert.notEqual(end, -1, 'frontmatter must be closed with ---');
  const data = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) data[match[1]] = match[2].trim();
  }
  return { data, body: normalized.slice(end + 5) };
}

function checkAgents() {
  const specs = [
    { file: 'meetingstone-executor.md', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
    { file: 'meetingstone-reviewer.md', tools: ['Read', 'Grep', 'Glob'] },
    { file: 'meetingstone-researcher.md', tools: ['Read', 'Grep', 'Glob'] },
  ];
  const allowedTools = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  for (const spec of specs) {
    const file = path.join(HERE, 'agents', spec.file);
    assert.ok(existsSync(file), `missing agent: ${spec.file}`);
    const { data, body } = parseFrontMatter(readFileSync(file, 'utf8'));
    assert.equal(data.name, spec.file.replace(/\.md$/, ''), `${spec.file}: name must match filename`);
    assert.ok((data.description || '').length >= 10, `${spec.file}: description is required`);
    assert.equal(data.mainAgent, 'true', `${spec.file}: mainAgent: true is required for the picker`);
    assert.equal(data.model, undefined, `${spec.file}: omit model so it inherits and stays unverified`);
    const tools = (data.tools || '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
    assert.ok(tools.length > 0, `${spec.file}: tools whitelist is required`);
    assert.ok(!tools.includes('*'), `${spec.file}: wildcard tools are not allowed`);
    for (const tool of tools) assert.ok(allowedTools.has(tool), `${spec.file}: unknown tool ${tool}`);
    for (const tool of tools) {
      assert.ok(spec.tools.includes(tool), `${spec.file}: unexpected tool ${tool}`);
    }
    for (const readOnlyTool of ['Edit', 'Write', 'MultiEdit', 'Bash']) {
      if (spec.file !== 'meetingstone-executor.md') {
        assert.ok(!tools.includes(readOnlyTool), `${spec.file}: read-only role must not include ${readOnlyTool}`);
      }
    }
    assert.ok(/[\u4e00-\u9fff]/.test(body), `${spec.file}: prompt body must be Chinese`);
    assert.ok(body.includes('meetingstone_list_roles'), `${spec.file}: must explain the MCP tool`);
    assert.ok(body.includes('未验证'), `${spec.file}: must require explicit unverified markers`);
  }
}

function checkSkill() {
  const file = path.join(HERE, 'skills', 'meetingstone-role-routing', 'SKILL.md');
  assert.ok(existsSync(file), 'missing optional skill: skills/meetingstone-role-routing/SKILL.md');
  const { data, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  assert.equal(data.name, 'meetingstone-role-routing');
  assert.ok((data.description || '').length >= 20, 'skill description is required');
  assert.ok((data.description_zh || '').length >= 5, 'skill description_zh is required for the UI label');
  assert.ok(/[\u4e00-\u9fff]/.test(body), 'skill body must be Chinese');
  for (const token of [
    'meetingstone_list_roles',
    'meetingstone-executor',
    'meetingstone-reviewer',
    'meetingstone-researcher',
    '未验证',
  ]) {
    assert.ok(body.includes(token), `skill body must mention ${token}`);
  }
}

function checkMcpConfig() {
  const config = JSON.parse(readFileSync(path.join(HERE, 'mcp.json'), 'utf8'));
  assert.ok(config.mcpServers && typeof config.mcpServers === 'object');
  const entries = Object.entries(config.mcpServers);
  assert.equal(entries.length, 1, 'mcp.json should register exactly one POC server');
  const [name, server] = entries[0];
  assert.equal(name, 'meetingstone-poc');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.ok(Array.isArray(server.args), 'server.args must be an array');
  assert.ok(
    server.args.some((arg) => typeof arg === 'string' && arg.replace(/\\/g, '/').endsWith('/server.mjs')),
    'mcp.json must point at server.mjs',
  );
}

function checkReadmeLinks() {
  const readmePath = path.join(HERE, 'README.md');
  assert.ok(existsSync(readmePath), 'missing README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const targets = [];
  for (const match of readme.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = decodeURIComponent(target.split('#')[0]);
    if (!clean) continue;
    const resolved = path.resolve(HERE, clean);
    assert.ok(existsSync(resolved), `dead local link in README: ${target}`);
    targets.push(target);
  }
  assert.ok(targets.length >= 5, `README should link the sample files (found ${targets.length})`);
}

function checkServerIsDependencyFree() {
  const source = readFileSync(SERVER, 'utf8');
  const sources = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(sources.length > 0, 'server.mjs should import node:readline');
  for (const specifier of sources) {
    assert.ok(specifier.startsWith('node:'), `server.mjs must not depend on ${specifier}`);
  }
}

const output = runServer();
const expectedIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, null, null, null, null];
assert.deepEqual(output.map((message) => message.id), expectedIds);
assert.ok(output.every((message) => message.jsonrpc === '2.0'));

// initialize
assert.equal(output[0].result.protocolVersion, '2025-06-18');
assert.deepEqual(output[0].result.capabilities, { tools: { listChanged: false } });
assert.equal(output[0].result.serverInfo.name, 'meetingstone-workbuddy-poc');
assert.equal(output[0].result.serverInfo.version, '0.1.0');

// tools/list: exactly one read-only tool with a closed schema.
assert.equal(output[1].result.tools.length, 1);
const tool = output[1].result.tools[0];
assert.equal(tool.name, 'meetingstone_list_roles');
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(tool.annotations.destructiveHint, false);
assert.equal(tool.inputSchema.type, 'object');
assert.deepEqual(tool.inputSchema.properties, {});
assert.equal(tool.inputSchema.additionalProperties, false);

// tools/call: fixed role snapshot.
assert.equal(output[2].result.isError, false);
assert.equal(output[2].result.content.length, 1);
assert.equal(output[2].result.content[0].type, 'text');
const snapshot = JSON.parse(output[2].result.content[0].text);
assert.equal(snapshot.schemaVersion, 1);
assert.equal(snapshot.source, 'workbuddy-poc-fixed');
assert.equal(snapshot.readOnly, true);
assert.deepEqual(
  snapshot.roles.map((role) => [role.roleId, role.name, role.duty, role.workbuddyAgent]),
  [
    ['role-sashi', '沙僧', '执行', 'meetingstone-executor'],
    ['role-wukong', '悟空', '评审', 'meetingstone-reviewer'],
    ['role-scout', '斥候', '调研', 'meetingstone-researcher'],
  ],
);
assert.ok(snapshot.roles.every((role) => role.enabled === true));

// ping and protocol-version fallback.
assert.deepEqual(output[3].result, {});
assert.equal(output[10].result.protocolVersion, '2025-06-18');
assert.equal(output[11].result.isError, false, 'omitted arguments should be accepted');

// Protocol errors.
assert.deepEqual(output.slice(4, 10).map((message) => message.error.code), [
  -32601, -32602, -32602, -32602, -32602, -32602,
]);
assert.equal(output[12].error.code, -32602, 'array params must be rejected');
assert.deepEqual(output.slice(13).map((message) => message.error.code), [
  -32600, -32700, -32600, -32600,
]);
assert.ok(output.slice(13).every((message) => message.id === null));

checkAgents();
checkSkill();
checkMcpConfig();
checkReadmeLinks();
checkServerIsDependencyFree();

console.log('PASS initialize: negotiated 2025-06-18, tools capability, serverInfo');
console.log('PASS notifications: initialized/cancelled produced no response');
console.log('PASS tools/list: one tool, closed input schema, readOnlyHint=true');
console.log('PASS tools/call: exact 3-role fixed snapshot, no arguments');
console.log('PASS errors: -32700 / -32600 / -32601 / -32602 all covered');
console.log('PASS agents: 3 frontmatter files, least-privilege tools, Chinese prompts');
console.log('PASS skill: optional routing SKILL.md, valid labels and Chinese body');
console.log('PASS mcp.json: stdio node server.mjs entry');
console.log('PASS docs: README local links resolve');
console.log('PASS dependencies: server.mjs uses node: built-ins only');
console.log('PASS: WorkBuddy POC self-check');
