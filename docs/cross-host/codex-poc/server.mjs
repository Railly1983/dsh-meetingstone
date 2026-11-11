// Codex POC MCP server: fixed, read-only MeetingStone role table plus a NOT_FOUND task placeholder.
// Zero dependencies. Line-delimited JSON-RPC 2.0 over stdio; stdout carries protocol only.
import { createInterface } from 'node:readline';

const SERVER_INFO = Object.freeze({ name: 'meetingstone-codex-poc', version: '0.2.0' });
const PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// Fixed snapshot, deliberately not read from disk at runtime. Read-only comes from this
// file having no fs/net/spawn access, not from the readOnlyHint annotation.
const ROLES = Object.freeze([
  Object.freeze({ id: 'meetingstone_wukong', name: '悟空', duty: '核心资深专家', enabled: true }),
  Object.freeze({ id: 'meetingstone_tangtang', name: '唐僧', duty: '评审与验收', enabled: true }),
]);

const ROLE_TABLE = Object.freeze({
  schemaVersion: 1,
  source: 'codex-poc-fixed',
  readOnly: true,
  roles: ROLES,
});

const LIST_ROLES_TOOL = Object.freeze({
  name: 'meetingstone_list_roles',
  title: 'List MeetingStone roles',
  description:
    'Return the fixed, read-only MeetingStone role table used by this Codex POC. Optional roleIds filters the snapshot; unknown ids are reported instead of invented.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      roleIds: Object.freeze({
        type: 'array',
        description: 'Optional role id allow-list. Omit to return every role.',
        items: Object.freeze({ type: 'string', minLength: 1 }),
        maxItems: 20,
      }),
    }),
    additionalProperties: false,
  }),
  annotations: READ_ONLY,
});

const GET_TASK_TOOL = Object.freeze({
  name: 'meetingstone_get_task',
  title: 'Get MeetingStone task',
  description:
    'Read-only placeholder. This POC does not read .meetingstone/runs, so every childId returns status NOT_FOUND. It never writes or dispatches.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      childId: Object.freeze({
        type: 'string',
        description: 'Dispatch childId to look up.',
        minLength: 1,
        maxLength: 128,
      }),
    }),
    required: Object.freeze(['childId']),
    additionalProperties: false,
  }),
  annotations: READ_ONLY,
});

const TOOLS = Object.freeze([LIST_ROLES_TOOL, GET_TASK_TOOL]);
const TOOL_NAMES = Object.freeze(TOOLS.map(tool => tool.name));

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const fail = (id, code, message) => send({ id, error: { code, message } });
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateArguments(name, args) {
  if (!isPlainObject(args)) return { ok: false, message: 'arguments must be an object' };
  const allowed = name === LIST_ROLES_TOOL.name ? ['roleIds'] : ['childId'];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return { ok: false, message: `unexpected argument: ${key}` };
  }
  if (name === GET_TASK_TOOL.name) {
    const { childId } = args;
    if (typeof childId !== 'string' || childId.length < 1 || childId.length > 128) {
      return { ok: false, message: 'childId must be a non-empty string of at most 128 characters' };
    }
    return { ok: true, value: { childId } };
  }
  if (args.roleIds === undefined) return { ok: true, value: {} };
  if (!Array.isArray(args.roleIds)) {
    return { ok: false, message: 'roleIds must be an array of non-empty strings' };
  }
  if (args.roleIds.length > 20) return { ok: false, message: 'roleIds accepts at most 20 entries' };
  for (const id of args.roleIds) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: 'roleIds entries must be non-empty strings' };
    }
  }
  return { ok: true, value: { roleIds: [...args.roleIds] } };
}

function callTool(name, args) {
  if (name === LIST_ROLES_TOOL.name) {
    const requested = args.roleIds;
    const roles = requested ? ROLES.filter(role => requested.includes(role.id)) : ROLES;
    const unknownRoleIds = requested
      ? [...new Set(requested.filter(id => !ROLES.some(role => role.id === id)))]
      : [];
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...ROLE_TABLE, roles, unknownRoleIds }) }],
      isError: false,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'NOT_FOUND',
          childId: args.childId,
          recordPath: null,
          note: '只读占位：未读取 .meetingstone/runs，也不写文件。',
        }),
      },
    ],
    isError: false,
  };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    continue;
  }
  if (!isPlainObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    fail(null, -32600, 'Invalid Request');
    continue;
  }
  if (!Object.hasOwn(request, 'id')) continue; // Notifications never receive responses.
  const { id } = request;
  if (id !== null && typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) {
    fail(null, -32600, 'Invalid id');
    continue;
  }
  let result;
  switch (request.method) {
    case 'initialize': {
      const version = PROTOCOL_VERSIONS.includes(request.params?.protocolVersion)
        ? request.params.protocolVersion
        : LATEST_PROTOCOL_VERSION;
      result = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
      break;
    }
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    case 'tools/call': {
      if (!isPlainObject(request.params)) {
        fail(id, -32602, 'params must be an object');
        continue;
      }
      if (!TOOL_NAMES.includes(request.params.name)) {
        fail(id, -32602, `Unknown tool: ${String(request.params.name)}`);
        continue;
      }
      const argumentsValue = request.params.arguments === undefined ? {} : request.params.arguments;
      const validated = validateArguments(request.params.name, argumentsValue);
      if (!validated.ok) {
        fail(id, -32602, validated.message);
        continue;
      }
      result = callTool(request.params.name, validated.value);
      break;
    }
    default:
      fail(id, -32601, 'Method not found');
      continue;
  }
  send({ id, result });
}
