"""Execute only extracted pure policy functions; never load or start WorkBuddy."""
import inspect_asar as a
import hashlib, json, pathlib, re, subprocess
ROOT = pathlib.Path(__file__).resolve().parent
def between(path, start, end):
    source = a.read(path)
    i = source.index(start)
    return source[i:source.index(end, i)]
daemon = 'main/daemon-bootstrap.js'
mount = 'renderer/assets/extension-mount-Dfjnas5X.js'
snippets = [
    between(daemon, 'function createDefaultThirdPartyDistribution(', 'function createThirdPartyDistribution('),
    between(daemon, 'function readDistribution(', 'function createExtensionRegistry('),
    between(mount, 'function resolveContainerFromUrl(', 'function deriveFederationTuple('),
    between(mount, 'function selectExtensionSettings(', 'function createUseExtensionFileSelectors('),
    between('main/netdrive-env-route.js', 'function expandPermission(', ',O=`wb:invoke:update`')+';',
    between('main/stdio-framing.js', 'function matchBridgePattern(', 'function createBridge('),
]
service = between(daemon, 'allowService:', ',allowBackground:').removeprefix('allowService:')
js = '\n'.join(snippets) + '\nconst allowService = '+service+';\n' + r'''
const assert = require('node:assert/strict');
const G = require('node:path');
const process = {env:{NODE_ENV:'production',WB_ALLOW_UNSIGNED_EXTENSION_SERVICE:'1'}};
const j = {verifyInstalled:()=>({verification:{status:'verified'}})};
let diskReads=0;
const W = {existsSync:()=>true, readFileSync:()=>{diskReads++;throw Error('must not read');}};
function createDefaultDistribution(id,version){return createDefaultThirdPartyDistribution(id,version);}
let checks=0;
function check(name,run){run();checks++;console.log('PASS '+name);}
(async()=>{
const manifest={id:'feasibility-fixture',version:'1.0.0'};
const dist=createDefaultThirdPartyDistribution(manifest.id,manifest.version);
check('default distribution grants no privileged methods',()=>assert.deepEqual(dist.grantedPermissions,[]));
check('user distribution override is ignored',()=>{
 assert.deepEqual(readDistribution(manifest,'C:/fixture',()=>dist,()=>false),dist);
 assert.equal(diskReads,0);
});
check('production dev extension service is denied even with unsigned flag',()=>assert.equal(allowService(manifest,dist,'C:/fixture','dev'),false));
check('verified installed service is admitted',()=>assert.equal(allowService(manifest,dist,'C:/fixture','installed'),true));
check('platform HTML renderer resolves to iframe',()=>assert.equal(resolveContainer('platform','wb-extension://fixture/ui/index.html'),'iframe'));
check('platform module federation renderer is rejected',()=>assert.equal(resolveContainer('platform','wb-extension://fixture/ui/remoteEntry.js'),'unsupported-federation-for-non-builtin'));
check('platform settings contribution is selected',()=>{
 const entries=selectExtensionSettings([{id:manifest.id,kind:'platform',enabled:true,ui:{entry:{url:'index.html'},settings:[{id:'overview',label:'Overview',target:'dataManagement'}]}}]);
 assert.equal(entries.length,1);assert.equal(entries[0].extensionKind,'platform');
});
const registry=new PermissionRegistry();
registry.registerSubject({moduleId:manifest.id,type:'extension',kind:'platform',permissions:['bus.emit','bus.on','context.set','context.delete']});
const auth=createBridgeAuthorizer(registry.toProvider());
const subject={moduleId:manifest.id,type:'extension',kind:'platform',scopes:[]};
for(const channel of ['wb:conversations:create','wb:conversations:ensureRuntime','wb:conversation:prompt','wb:conversation:cancel','wb:artifacts:get','worktreeTask:createWorktree']) {
 const decision=await auth.authorize({subject,action:{type:'invoke',channel}});
 check('ordinary extension denied '+channel,()=>{assert.equal(decision.allowed,false);assert.equal(decision.reason,'MISSING_GRANT');});
}
const baseDecision=await auth.authorize({subject,action:{type:'invoke',channel:'wb:context:set'}});
check('actual baseline context method remains allowed',()=>assert.equal(baseDecision.allowed,true));
console.log('TOTAL '+checks+' PASS, 0 FAIL; no desktop process, session, network request or configuration write');
})().catch(e=>{console.error(e);globalThis.process.exitCode=1;});
'''
result = subprocess.run(['node', '-'], input=js, text=True, encoding='utf-8', capture_output=True)
(ROOT/'policy-tests.log').write_text(result.stdout+result.stderr,encoding='utf-8')
print(result.stdout+result.stderr)
if result.returncode: raise SystemExit(result.returncode)
queries = [
 (daemon, 'function createDefaultThirdPartyDistribution(', 190),
 (daemon, 'resolveDistribution:({manifest:', 700),
 (daemon, 'allowService:', 300),
 (daemon, 'var Dc=', 270),
 (daemon, 'requireSignature:!0', 120),
 (daemon, 'A=process.env.NODE_ENV!==`production`', 330),
 (daemon, 'function verifyExtensionIntegritySignature(', 1300),
 (daemon, 'function createExtensionPermissionSetup(', 1500),
 ('main/netdrive-env-route.js', 'function expandPermission(', 1900),
 ('main/stdio-framing.js', 'function createBridgeAuthorizer(', 1400),
 (mount, 'function resolveContainerFromUrl(', 340),
 (mount, 'function selectExtensionSettings(', 320),
 ('renderer/assets/contexts-Cfdc2AZw.js', 'case`extensions`:return C?', 260),
 ('renderer/assets/DataManagementPanel-DrmkV68V.js', 'rget===`dataManagement`', 450),
 ('main/server.js', 'function buildUiInfo(', 1600),
 ('main/server.js', 'var WorkbuddyACPClient=', 1100),
 ('main/server.js', 'function createWorkbuddyAgentAcpClient(', 1400),
 ('main/server.js', 'args:[a,`--serve`,`--session-id`', 550),
 ('main/rpc-connection.js', 'if(C.subject.type===`extension`)return{__wbError:!0,message:`extension subjects may only invoke authorized wb:* channels', 300),
 ('main/pidusage.js', 'function resolveExtensionsDevRoot(', 450),
 ('main/pidusage.js', 'function resolveExtensionRoot(', 1600),
 ('node_modules/@genie/agent-harness/lib/protocol/acp-v2.js', 'export const ACP_V2_METHODS=', 1150),
 ('main/app-instance.js', 'function configureElectronApp(', 400),
 ('main/workbuddy-product-config.js', 'function resolveWorkbuddyConfigDir(', 250),
 ('cli/dist/codebuddy-lite-wb.mjs', 'function resolveCliHomeDir(', 400),
 ('cli/dist/codebuddy-lite-wb.mjs', 'static getHomeAgentsDir(', 140),
 ('cli/dist/codebuddy-lite-wb.mjs', 'async loadCustomAgents(){let t=new Map', 1100),
 ('cli/dist/codebuddy-lite-wb.mjs', 'async scanAgentsDirectory(', 1700),
 ('main/server.js', 'function createWorktreeTaskService(', 2400),
 ('main/server.js', 'function registerWorktreeTaskHandlers(', 1150),
 ('main/handler-registry.js', 'IS_GIT_REPO:`worktreeTask:', 1650),
]
out = [f'ASAR={a.ARCHIVE}', 'version='+json.loads(a.read('package.json'))['version'],
       'sha256='+hashlib.file_digest(a.ARCHIVE.open('rb'),'sha256').hexdigest()]
for path, symbol, length in queries:
    source=a.read(path)
    i=source.find(symbol)
    if i<0:
        out.append(f'NOT FOUND {path}: {symbol}')
        continue
    line=source.count('\n',0,i)+1
    column=i-source.rfind('\n',0,i)
    out.append(f'\n{path}:{line}:{column} {symbol}\n'+source[i:i+length])
for path in ['resources/extensions/edge-sync/extension.json','resources/extensions/edge-sync/distribution.json']:
    out.append('\n'+path+'\n'+'\n'.join(f'{i}: {s}' for i,s in enumerate(a.read(path).splitlines(),1)))
count=0; hits=[]; skipped=[]
for path in a.files:
    if not path.endswith(('.js','.mjs','.cjs','.json','.md','.d.ts')): continue
    try: content=a.read(path)
    except OSError as error:
        skipped.append({'file':path,'errno':error.errno}); continue
    count+=1
    if 'dsh-protocol/acp-v2' in content: hits.append(path)
out.append(f'\nLiteral dsh-protocol/acp-v2 scan: {count} readable packaged text files, hits={hits}; skipped={json.dumps(skipped)}')
(ROOT/'code-evidence.log').write_text('\n'.join(out),encoding='utf-8')
print(f'Code evidence saved; literal scan {count} readable files, hits={hits}, skipped={len(skipped)}')
