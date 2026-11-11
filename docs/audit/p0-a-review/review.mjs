// Independent P0-A probes. Run from repository root: node docs/audit/p0-a-review/review.mjs
import assert from 'node:assert/strict'
import { readFile, mkdir, cp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDshAdapter } from '../../../src/dsh/adapter.js'
import { createDispatcher } from '../../../src/dispatch/dispatcher.js'
import { createRegistry } from '../../../src/roles/registry.js'
import { registerTools, TOOL_NAMES } from '../../../src/dsh/register.js'
import { createRunStore } from '../../../src/run-store.js'
import { formatContinuation } from '../../../src/context-replay.js'

const dir = fileURLToPath(new URL('.', import.meta.url))
const root = process.cwd()
const role = { roleId: 'role-wukong', name: '悟空', aliases: ['WK'], enabled: true,
  channel: { kind: 'codex', channelId: 'audit-channel', model: 'audit-model' }, timeoutMs: 0,
  description: '独立审核', prompt: '保留当前任务边界', source: 'global' }
const parent = { id: 'audit-session', session: { id: 'audit-session', header: { cwd: root } } }
const exec = { agent: parent }
const size = x => Buffer.byteLength(JSON.stringify(x))
const log = (name, data) => console.log(name, JSON.stringify(data))
const turn = () => new Promise(resolve => setImmediate(resolve))

function setup(mode = 'normal', disposeMode = 'ok') {
  const registered = new Map(), jobs = [], warnings = [], activations = [], started = [], finished = []
  const registry = createRegistry({ globalRoles: [role] })
  const ctx = { tools: { register: s => registered.set(s.name, s) }, logger: { warn: s => warnings.push(s), info() {} },
    subagents: { getProvider: name => name === 'codex' ? { name } : undefined,
      async startActivation(spec) {
        let fulfill, reject
        const result = new Promise((a,b) => { fulfill=a; reject=b })
        const a = { spec, fulfill, reject, live: true, disposeCalls: 0 }
        activations.push(a)
        return { childId: `audit-child-${activations.length}`, name: 'audit-agent', result,
          async dispose() { a.disposeCalls++; if(disposeMode === 'throw') throw Error('dispose blocked'); a.live=false } }
      } } }
  const jobService = { start(spec) {
    if (mode === 'broken') throw Error('no job controller')
    const j = { spec, progress: [], kills: 0, id: `meetingstone-dispatch-audit-${jobs.length}` }
    j.hooks = spec.run({ updateProgress: s => j.progress.push(s), append() {} }); jobs.push(j); return j.id
  }, kill(id) { const j=jobs.find(j=>j.id===id); j.kills++; j.hooks.cancel() } }
  if (mode !== 'absent') ctx.get = name => name === 'jobs' ? jobService : undefined
  const adapter = createDshAdapter(ctx, { channels: [{channelId:'audit-channel',kind:'codex',model:'audit-model'}], disposeTimeoutMs: 20,
    onRunStart: r=>started.push(r), onRunFinish: r=>finished.push(r) })
  const dispatcher = createDispatcher({ registry, adapter })
  registerTools(ctx, { registry, dispatcher, probe: { probe: async()=>({}), probeAll: async()=>[] } })
  const call = (name,args) => registered.get(name).execute(args,exec)
  return { call, jobs, warnings, activations, started, finished, registered, dispatcher }
}

const s=setup()
const receipt=await s.call(TOOL_NAMES.DISPATCH, { role:'WK', task:'旧调用：审核即可' })
assert.equal(receipt.ok,true,JSON.stringify(receipt))
log('dispatch_legacy', { bytes:size(receipt), value:receipt, prompt:s.activations[0].spec.request.prompt })
assert.equal(s.jobs[0].spec.kind,'meetingstone-dispatch')
assert.equal(s.jobs[0].spec.label,'悟空 · codex · 旧调用：审核即可')
assert.equal(s.started[0].jobId,receipt.taskRef.jobId)
const critical='验收标准：测试全绿；权限限制：禁止部署；任务边界：只改 tests；安全策略：不得外传凭据'
const text='头部\n'+'中'.repeat(5000)+critical+'后'.repeat(6000)+'\n尾部'
s.activations[0].fulfill({stopReason:'completed',output:[{type:'text',text}]})
const completed=await s.jobs[0].hooks.done
const compact=await s.call(TOOL_NAMES.GET_TASK,{childId:receipt.taskRef.childId})
const full=await s.call(TOOL_NAMES.GET_TASK,{childId:receipt.taskRef.childId,full:true})
assert.equal(full.result,text)
assert.equal(Object.hasOwn(full,'output'),false)
assert.equal(compact.resultTruncated,true)
assert.equal(compact.result.includes(critical),false)
assert.equal(s.registered.get(TOOL_NAMES.GET_TASK).output.render({},compact)[0].text,JSON.stringify(compact))
assert.equal(Object.hasOwn(compact,'output'),false)
log('get_task',{compactBytes:size(compact),fullBytes:size(full),resultBytes:full.resultBytes,
  previewBytes:Buffer.byteLength(compact.result),criticalInCompact:compact.result.includes(critical),criticalInFull:full.result.includes(critical),completed})
const roles=await s.call(TOOL_NAMES.LIST_ROLES,{})
const verbose=await s.call(TOOL_NAMES.LIST_ROLES,{verbose:true})
assert.equal(verbose.roles[0].model,'audit-model')
log('list_roles',{compactBytes:size(roles),verboseBytes:size(verbose),compactFields:Object.keys(roles.roles[0]),verboseFields:Object.keys(verbose.roles[0])})
const fail=setup(); await fail.call(TOOL_NAMES.DISPATCH,{role:'WK',task:'失败反例'})
fail.activations[0].reject(Error('provider boom'))
log('failed',await fail.jobs[0].hooks.done)
const panel=setup(); const pr=await panel.call(TOOL_NAMES.DISPATCH,{role:'WK',task:'面板停止'})
await panel.jobs[0].hooks.cancel()
const panelDone=await panel.jobs[0].hooks.done
assert.equal(panel.activations[0].disposeCalls,1)
assert.equal(panel.activations[0].spec.signal.aborted,true)
assert.equal(panel.activations[0].live,false)
log('panel_cancel',{outcome:panelDone,disposeCalls:panel.activations[0].disposeCalls,aborted:panel.activations[0].spec.signal.aborted,live:panel.activations[0].live})
const tool=setup(); const tr=await tool.call(TOOL_NAMES.DISPATCH,{role:'WK',task:'工具停止'})
log('tool_cancel',await tool.call(TOOL_NAMES.CANCEL_TASK,{childId:tr.taskRef.childId}))
assert.equal(tool.jobs[0].kills,1); assert.equal(tool.activations[0].disposeCalls,1)
for (const mode of ['absent','broken']) {
  const env=setup(mode); const r=await env.call(TOOL_NAMES.DISPATCH,{role:'WK',task:'兼容验证'})
  assert.equal(r.ok,true); assert.equal(Object.hasOwn(r.taskRef,'jobId'),false)
  log(mode,{ok:r.ok,warnings:env.warnings})
  env.activations[0].fulfill({stopReason:'completed',output:[]}); await turn()
}
const blocked=setup('normal','throw'); await blocked.call(TOOL_NAMES.DISPATCH,{role:'WK',task:'停止失败'})
const stop=await blocked.jobs[0].hooks.cancel()
log('stop_unconfirmed',{stop,outcome:await blocked.jobs[0].hooks.done,live:blocked.activations[0].live,progress:blocked.jobs[0].progress.at(-1)})
blocked.activations[0].fulfill({stopReason:'completed',output:[]}); await turn()
const replay=formatContinuation({childId:'previous',status:'completed',result:text,
  acceptance:['全部测试通过'],permissions:{deploy:false},safetyPolicy:'禁止外传',scope:'tests only'})
log('replay',{bytes:replay.bytes,truncated:replay.truncated,criticalRetained:replay.text.includes(critical),structuredRetained:replay.text.includes('全部测试通过')})
assert.equal(replay.text.includes(critical),false)
const storeRoot=resolve(dir,'.generated/store')
await mkdir(storeRoot,{recursive:true})
const old=createRunStore({root:storeRoot,runtimeId:'before'})
await old.writeRun({childId:'restart',status:'running',jobId:'old-job'})
const fresh=createRunStore({root:storeRoot,runtimeId:'after'})
const projected=await fresh.loadRun('restart')
assert.equal(projected.status,'interrupted')
log('restart',{status:projected.status,interrupted:projected.interrupted,jobId:projected.jobId,path:fresh.pathFor('restart')})
// Persisted full:true is still bounded by the existing 256KiB store cap.
const huge='a'.repeat(300000)
await old.writeRun({childId:'huge',status:'completed',result:huge})
const persisted=await fresh.loadRun('huge')
log('persisted_full_limit',{originalBytes:huge.length,storedBytes:Buffer.byteLength(persisted.result),resultTruncated:persisted.resultTruncated})

// Execute unchanged functions extracted from this machine's installed host bundle.
const host=await readFile(resolve(dir,'host-jobs.js'),'utf8')
const client=await readFile(resolve(dir,'host-jobs-client.js'),'utf8')
const terminalSource=host.match(/function isTerminal\(status\) \{[\s\S]*?\n\}/)[0]
const terminal=Function(`${terminalSource}; return isTerminal`)()
const labelSource=client.match(/function statusLabel\(status, t\) \{[\s\S]*?\n\t\t\}/)[0]
const label=Function(`function assertNever(value){throw Error('unhandled job status: '+JSON.stringify(value))}; ${labelSource}; return statusLabel`)()
for (const outcome of [completed,await fail.jobs[0].hooks.done,panelDone]) {
  let rendered
  try { rendered=label(outcome.status,x=>x) } catch(e) { rendered=e.message }
  log('host_status_probe',{status:outcome.status,terminal:terminal(outcome.status),rendered})
}
assert.equal(terminal(panelDone.status),false)
assert.throws(()=>label(panelDone.status,x=>x),/unhandled job status/)

// Prepare isolated mutations; original production files are never modified.
for(const [name,from,to] of [
  ['no-panel-cancel','cancel: () => cancel(),','cancel: () => {},'],
  ['no-dispose','Promise.resolve().then(() => activation.dispose()),','Promise.resolve(),'],
]) {
  const target=resolve(dir,'.generated',name)
  await mkdir(resolve(target,'tests'),{recursive:true})
  await cp(resolve(root,'src'),resolve(target,'src'),{recursive:true})
  await cp(resolve(root,'tests/jobs.test.mjs'),resolve(target,'tests/jobs.test.mjs'))
  const path=resolve(target,'src/dsh/adapter.js')
  const original=await readFile(path,'utf8')
  assert.equal(original.split(from).length,2)
  await writeFile(path,original.replace(from,to))
  log('mutation_prepared',{name,entry:resolve(target,'tests/jobs.test.mjs')})
  const changed=await import(pathToFileURL(path).href)
  let hooks, signal, disposeCalls=0, live=true
  const mutated=changed.createDshAdapter({logger:{warn(){}},
    jobs:{start(spec){hooks=spec.run({updateProgress(){}});return 'mutant-job'}},
    subagents:{getProvider(){return {}},async startActivation(spec){signal=spec.signal;
      return {childId:'mutant-child',name:'mutant',result:new Promise(()=>{}),
        async dispose(){disposeCalls++;live=false}}
    }}},{channels:[]})
  await mutated.start({role:{...role,channel:{kind:'codex'}},task:'panel probe',timeoutMs:0,
    context:{projectRoot:root,agent:parent}})
  const cancelResult=await hooks.cancel()
  log('mutation_behavior',{name,cancelResult,disposeCalls,aborted:signal.aborted,live,
    task:await mutated.getTask('mutant-child')})
}
console.log('PROBES_COMPLETE: assertions passed; observed contract/safety defects are logged above')
