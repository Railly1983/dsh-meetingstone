import { createInterface } from 'node:readline';
const roles = [{ id: 'meetingstone_wukong', name: '悟空', description: '核心资深专家；只读核验' }];
const tool = { name: 'meetingstone_list_roles', description: '返回固定角色表（只读）', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
const fail = (id, code, message) => send({ id, error: { code, message } });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let r;
  try { r = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
  if (!r || Array.isArray(r) || r.jsonrpc !== '2.0' || typeof r.method !== 'string') { fail(null, -32600, 'Invalid Request'); continue; }
  if (!Object.hasOwn(r, 'id')) continue; // Notifications never receive responses.
  if (r.id !== null && typeof r.id !== 'string' && !(typeof r.id === 'number' && Number.isFinite(r.id))) { fail(null, -32600, 'Invalid id'); continue; }
  let result;
  switch (r.method) {
    case 'initialize': {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      result = { protocolVersion: supported.includes(r.params?.protocolVersion) ? r.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meetingstone-poc', version: '0.1.0' } }; break;
    }
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: [tool] }; break;
    case 'tools/call': {
      const a = r.params?.arguments === undefined ? {} : r.params.arguments;
      if (r.params?.name !== tool.name || !a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length) { fail(r.id, -32602, 'Unknown tool or invalid arguments'); continue; }
      result = { content: [{ type: 'text', text: JSON.stringify({ roles }) }], isError: false }; break;
    }
    default: fail(r.id, -32601, 'Method not found'); continue;
  }
  send({ id: r.id, result });
}
