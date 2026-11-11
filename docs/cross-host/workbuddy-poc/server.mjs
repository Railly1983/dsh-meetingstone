// WorkBuddy POC MCP server: fixed, read-only MeetingStone role table.
// Zero dependencies. Line-delimited JSON-RPC 2.0 over stdio; stdout carries protocol only.
import { createInterface } from 'node:readline';

const SERVER_INFO = Object.freeze({
  name: 'meetingstone-workbuddy-poc',
  version: '0.1.0',
});

const PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

// Fixed snapshot, deliberately not read from disk at runtime. It only demonstrates
// that WorkBuddy can discover and call one read-only MeetingStone tool.
const ROLE_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  source: 'workbuddy-poc-fixed',
  readOnly: true,
  note: '固定快照，不读取集合石实时配置；仅用于 WorkBuddy POC 联调。',
  roles: Object.freeze([
    Object.freeze({
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: Object.freeze(['SS', '主力执行']),
      duty: '执行',
      workbuddyAgent: 'meetingstone-executor',
      enabled: true,
    }),
    Object.freeze({
      roleId: 'role-wukong',
      name: '悟空',
      aliases: Object.freeze(['WK', '专家']),
      duty: '评审',
      workbuddyAgent: 'meetingstone-reviewer',
      enabled: true,
    }),
    Object.freeze({
      roleId: 'role-scout',
      name: '斥候',
      aliases: Object.freeze(['SC']),
      duty: '调研',
      workbuddyAgent: 'meetingstone-researcher',
      enabled: true,
    }),
  ]),
});

const LIST_ROLES_TOOL = Object.freeze({
  name: 'meetingstone_list_roles',
  title: 'List MeetingStone roles',
  description:
    'Return the fixed, read-only MeetingStone role subset used by this WorkBuddy POC. It never reads local configuration and performs no writes.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function rpcError(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function writeResult(id, result) {
  writeMessage({ id, result });
}

function writeError(id, code, message) {
  writeMessage({ id, error: { code, message } });
}

function callTool(params) {
  if (!isPlainObject(params)) {
    throw rpcError(ERROR_CODES.INVALID_PARAMS, 'tools/call params must be an object');
  }
  if (params.name !== LIST_ROLES_TOOL.name) {
    throw rpcError(ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isPlainObject(args)) {
    throw rpcError(ERROR_CODES.INVALID_PARAMS, 'tools/call arguments must be an object');
  }
  if (Object.keys(args).length > 0) {
    throw rpcError(ERROR_CODES.INVALID_PARAMS, 'meetingstone_list_roles takes no arguments');
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(ROLE_SNAPSHOT) }],
    isError: false,
  };
}

function handleRequest(request) {
  if (request.params !== undefined && !isPlainObject(request.params)) {
    throw rpcError(ERROR_CODES.INVALID_PARAMS, 'params must be an object');
  }
  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Read-only POC server. Call meetingstone_list_roles to get the fixed MeetingStone role subset. No files, network, or configuration are accessed.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [LIST_ROLES_TOOL] };
    case 'tools/call':
      return callTool(request.params);
    default:
      throw rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${request.method}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const rawLine of lines) {
  const line = rawLine.trim();
  if (line === '') continue;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeError(null, ERROR_CODES.PARSE_ERROR, 'Parse error');
    continue;
  }

  if (!isPlainObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    writeError(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
    continue;
  }

  // JSON-RPC notifications (no id) never receive a response, including unknown ones.
  if (!Object.hasOwn(request, 'id')) continue;

  if (!isValidId(request.id)) {
    writeError(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: invalid id');
    continue;
  }

  try {
    writeResult(request.id, handleRequest(request));
  } catch (error) {
    if (error?.rpcCode !== undefined) {
      writeError(request.id, error.rpcCode, error.message);
    } else {
      process.stderr.write(
        `[meetingstone-workbuddy-poc] internal error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      writeError(request.id, ERROR_CODES.INTERNAL_ERROR, 'Internal error');
    }
  }
}
