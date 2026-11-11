#!/usr/bin/env node
// Offline self-check for the Codex POC. No dependencies, no network, no host writes.
// Checks: file presence, syntax, role TOML contract, MCP registration snippet, local links,
// then drives server.mjs over stdio for handshake / discovery / calls / errors / EOF.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRICT = process.argv.includes('--strict');
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`SKIP ${name}: ${why}`);
}

console.log(`INFO node=${process.version} platform=${process.platform} dir=${HERE}`);

// ---------------------------------------------------------------- static: files
const EXPECTED_FILES = [
  'README.md',
  'ACCEPTANCE.md',
  'config.example.toml',
  'meetingstone_wukong.toml',
  'meetingstone_tangtang.toml',
  'server.mjs',
  'smoke.mjs',
  'verify-offline.mjs',
];
for (const file of EXPECTED_FILES) {
  ok(`file exists: ${file}`, () => assert.ok(existsSync(join(HERE, file)), 'missing'));
}

// ---------------------------------------------------------------- static: syntax
const canSpawn = (() => {
  if (process.argv.includes('--no-spawn')) {
    skip('spawn node', '--no-spawn: 模拟沙箱 EPERM（用管道模式或 Python 驱动）');
    return false;
  }
  const probe = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', timeout: 5000 });
  if (probe.error && (probe.error.code === 'EPERM' || probe.error.code === 'EACCES')) {
    skip('spawn node', `${probe.error.code}: 沙箱禁止子进程；改用独立 stdio 管道模式或 Python 驱动`);
    return false;
  }
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  return true;
})();

if (canSpawn) {
  for (const file of ['server.mjs', 'smoke.mjs', 'verify-offline.mjs']) {
    ok(`node --check ${file}`, () => {
      const result = spawnSync(process.execPath, ['--check', join(HERE, file)], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, (result.stderr || '').trim());
    });
  }
}

// ---------------------------------------------------------------- static: source boundaries
const serverSource = readFileSync(join(HERE, 'server.mjs'), 'utf8');
ok('server.mjs imports only node: builtins', () => {
  const specs = [...serverSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specs.length > 0, 'no import found');
  for (const spec of specs) assert.ok(spec.startsWith('node:'), `unexpected import ${spec}`);
});
ok('server.mjs has no filesystem / network / spawn access', () => {
  for (const banned of ['node:fs', 'node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'homedir', 'process.env']) {
    assert.ok(!serverSource.includes(banned), `found ${banned}`);
  }
});

// ---------------------------------------------------------------- static: role TOML
function parseTomlSubset(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, rest] = match;
    if (rest.startsWith('"""')) {
      let value = rest.slice(3);
      if (value.includes('"""')) {
        out[key] = value.slice(0, value.indexOf('"""'));
        continue;
      }
      let closed = false;
      for (i++; i < lines.length; i++) {
        const end = lines[i].indexOf('"""');
        if (end >= 0) {
          value += (value ? '\n' : '') + lines[i].slice(0, end);
          closed = true;
          break;
        }
        value += (value ? '\n' : '') + lines[i];
      }
      assert.ok(closed, `${key}: unterminated triple-quoted string`);
      out[key] = value;
    } else if (rest.startsWith('"')) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      assert.ok(quoted, `${key}: unterminated string`);
      out[key] = JSON.parse(`"${quoted[1]}"`);
    } else {
      out[key] = rest.trim();
    }
  }
  return out;
}

const roleFiles = readdirSync(HERE)
  .filter(file => /^meetingstone_.+\.toml$/.test(file))
  .sort();
ok('role TOMLs: exactly two', () => assert.deepEqual(roleFiles, ['meetingstone_tangtang.toml', 'meetingstone_wukong.toml']));

const roleDocs = roleFiles.map(file => ({ file, ...parseTomlSubset(readFileSync(join(HERE, file), 'utf8')) }));
for (const role of roleDocs) {
  ok(`role ${role.file}: name matches file stem`, () => {
    assert.equal(role.name, role.file.replace(/\.toml$/, ''));
  });
  ok(`role ${role.file}: description follows 角色简称 · 目标`, () => {
    assert.match(role.description, /^[^\s·]+ · \S+$/u);
    assert.ok(Array.from(role.description).length <= 14, `description too long: ${role.description}`);
  });
  ok(`role ${role.file}: has developer_instructions and marker`, () => {
    assert.ok(role.developer_instructions && role.developer_instructions.trim().length > 20);
    assert.match(role.developer_instructions, /POC_[A-Z]+/);
    assert.match(role.developer_instructions, /只读|不.*修改|不.*写/u);
  });
  ok(`server.mjs exposes ${role.name}`, () => {
    assert.ok(serverSource.includes(`id: '${role.name}'`), `missing role id ${role.name}`);
  });
}

// ---------------------------------------------------------------- static: registration snippet
const config = readFileSync(join(HERE, 'config.example.toml'), 'utf8');
ok('config: registers meetingstone_poc over stdio', () => {
  assert.match(config, /^\[mcp_servers\.meetingstone_poc\]$/m);
  assert.match(config, /command\s*=\s*"node"/);
  assert.match(config, /server\.mjs/);
});
ok('config: enables both tools', () => {
  for (const name of ['meetingstone_list_roles', 'meetingstone_get_task']) {
    assert.ok(config.includes(`"${name}"`), `missing ${name}`);
  }
});
ok('config: caps concurrent child threads at 1', () => {
  assert.match(config, /max_concurrent_threads_per_session\s*=\s*1/);
});

// ---------------------------------------------------------------- static: docs
function localLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map(match => match[1])
    .filter(link => !/^(?:https?:|#|mailto:)/.test(link));
}
for (const doc of ['README.md', 'ACCEPTANCE.md']) {
  const markdown = readFileSync(join(HERE, doc), 'utf8');
  for (const link of localLinks(markdown)) {
    ok(`${doc} link resolves: ${link}`, () => {
      const target = decodeURIComponent(link.split('#')[0]);
      assert.ok(existsSync(resolve(HERE, target)), `missing ${target}`);
    });
  }
}
const acceptance = readFileSync(join(HERE, 'ACCEPTANCE.md'), 'utf8');
ok('ACCEPTANCE covers registration/start/read/cancel/concurrency/worktree/verdicts', () => {
  for (const keyword of ['注册', '启动', '回读', '取消', '并发', 'worktree', 'PASS', 'FAIL', '未验证']) {
    assert.ok(acceptance.includes(keyword), `missing keyword ${keyword}`);
  }
  assert.match(acceptance, /不写[^\n]*~\/\.codex/);
});
const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
ok('README states real-machine verification is not done', () => {
  assert.match(readme, /真机[^\n]*未执行|真机[^\n]*未验证/);
  assert.ok(readme.includes('ACCEPTANCE.md'));
});

// ---------------------------------------------------------------- protocol over stdio
if (canSpawn) {
  const requests = [
    {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-offline', version: '1' } },
    },
    {
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'verify-offline', version: '1' } },
    },
    { method: 'notifications/initialized', params: {} },
    { id: 3, method: 'ping', params: {} },
    { id: 4, method: 'tools/list', params: {} },
    { id: 5, method: 'tools/call', params: { name: 'meetingstone_list_roles', arguments: {} } },
    {
      id: 6,
      method: 'tools/call',
      params: { name: 'meetingstone_list_roles', arguments: { roleIds: ['meetingstone_wukong'] } },
    },
    {
      id: 7,
      method: 'tools/call',
      params: { name: 'meetingstone_list_roles', arguments: { roleIds: ['missing-role'] } },
    },
    {
      id: 8,
      method: 'tools/call',
      params: { name: 'meetingstone_get_task', arguments: { childId: 'verify-missing' } },
    },
    { id: 9, method: 'missing/method', params: {} },
    { id: 10, method: 'tools/call', params: { name: 'meetingstone_get_task', arguments: {} } },
    { id: 11, method: 'tools/call', params: { name: 'meetingstone_get_task', arguments: { childId: 7 } } },
    {
      id: 12,
      method: 'tools/call',
      params: { name: 'meetingstone_list_roles', arguments: { write: true } },
    },
    { id: 13, method: 'tools/call', params: { name: 'unknown_tool', arguments: {} } },
    { id: 14, method: 'tools/call', params: { name: 'meetingstone_list_roles', arguments: null } },
    { id: 15, method: 'tools/call', params: { name: 'meetingstone_list_roles', arguments: [1] } },
    {
      id: 16,
      method: 'tools/call',
      params: { name: 'meetingstone_list_roles', arguments: { roleIds: [1] } },
    },
    '{"jsonrpc":"2.0",',
    '[]',
    '{"jsonrpc":"2.0","id":{},"method":"ping"}',
  ];
  const input = requests.map(item => (typeof item === 'string' ? item : JSON.stringify({ jsonrpc: '2.0', ...item }))).join('\n') + '\n';
  const result = spawnSync(process.execPath, [join(HERE, 'server.mjs')], {
    input,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) {
    skip('protocol over stdio', `${result.error.code ?? 'spawn error'}: ${result.error.message}`);
  } else {
    ok('protocol: server exits 0 with empty stderr on EOF', () => {
      assert.equal(result.status, 0, (result.stderr || '').trim());
      assert.equal(result.stderr, '');
    });
    const out = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    ok('protocol: one response per request, notification silent', () => {
      assert.deepEqual(
        out.map(message => message.id),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, null, null, null],
      );
      assert.ok(out.every(message => message.jsonrpc === '2.0'));
    });
    ok('protocol: initialize negotiates and falls back to 2025-06-18', () => {
      assert.equal(out[0].result.protocolVersion, '2025-06-18');
      assert.deepEqual(out[0].result.capabilities, { tools: {} });
      assert.equal(out[1].result.protocolVersion, '2025-06-18');
      assert.equal(out[0].result.serverInfo.name, 'meetingstone-codex-poc');
    });
    ok('protocol: ping returns {}', () => assert.deepEqual(out[2].result, {}));
    const tools = out[3].result.tools;
    ok('protocol: tools/list exposes exactly two tools', () => {
      assert.equal(tools.length, 2);
      assert.deepEqual(tools.map(tool => tool.name), ['meetingstone_list_roles', 'meetingstone_get_task']);
    });
    ok('protocol: every tool schema is closed', () => {
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must set additionalProperties:false`);
        for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) {
          if (property.type === 'array') {
            assert.ok(property.items && property.items.type, `${tool.name}.${key} must declare items.type`);
          }
        }
      }
    });
    ok('protocol: get_task requires childId', () => {
      const getTask = tools.find(tool => tool.name === 'meetingstone_get_task');
      assert.ok(getTask.inputSchema.required.includes('childId'));
    });
    ok('protocol: both tools are annotated read-only', () => {
      for (const tool of tools) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.annotations.idempotentHint, true);
      }
    });
    ok('protocol: list_roles returns both roles', () => {
      assert.equal(out[4].result.isError, false);
      const payload = JSON.parse(out[4].result.content[0].text);
      assert.equal(payload.readOnly, true);
      assert.deepEqual(
        payload.roles.map(role => [role.id, role.name]),
        [
          ['meetingstone_wukong', '悟空'],
          ['meetingstone_tangtang', '唐僧'],
        ],
      );
      assert.deepEqual(payload.unknownRoleIds, []);
    });
    ok('protocol: roleIds filters without inventing roles', () => {
      const filtered = JSON.parse(out[5].result.content[0].text);
      assert.deepEqual(filtered.roles.map(role => role.id), ['meetingstone_wukong']);
      assert.deepEqual(filtered.unknownRoleIds, []);
      const missing = JSON.parse(out[6].result.content[0].text);
      assert.deepEqual(missing.roles, []);
      assert.deepEqual(missing.unknownRoleIds, ['missing-role']);
    });
    ok('protocol: get_task returns NOT_FOUND placeholder', () => {
      assert.equal(out[7].result.isError, false);
      const payload = JSON.parse(out[7].result.content[0].text);
      assert.equal(payload.status, 'NOT_FOUND');
      assert.equal(payload.childId, 'verify-missing');
      assert.equal(payload.recordPath, null);
    });
    ok('protocol: unknown method returns -32601', () => assert.equal(out[8].error.code, -32601));
    ok('protocol: invalid parameters return -32602', () => {
      for (const index of [9, 10, 11, 12, 13, 14, 15]) assert.equal(out[index].error.code, -32602, `index ${index}`);
    });
    ok('protocol: parse / invalid request return -32700 / -32600', () => {
      assert.equal(out[16].error.code, -32700);
      assert.equal(out[17].error.code, -32600);
      assert.equal(out[18].error.code, -32600);
    });
    ok('protocol: server snapshot matches role TOML names', () => {
      const payload = JSON.parse(out[4].result.content[0].text);
      assert.deepEqual(
        payload.roles.map(role => role.id).sort(),
        roleDocs.map(role => role.name).sort(),
      );
    });
  }
} else {
  skip('protocol over stdio', '子进程不可用；见 README「独立 stdio 管道模式」或 Python 驱动');
}

// ---------------------------------------------------------------- summary
if (failed > 0) {
  console.error(`FAIL: offline self-check (${failed} failed, ${passed} passed, ${skipped} skipped)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else if (skipped > 0 && STRICT) {
  console.error(`FAIL: --strict treats ${skipped} skipped check(s) as failure`);
  process.exitCode = 1;
} else {
  console.log(`PASS: offline self-check (${passed} passed${skipped ? `, ${skipped} skipped` : ''})`);
}
