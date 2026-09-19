import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { HerdrClient } from '../../../src/herdr-client';
import { HerdrStateReporter } from '../../../src/state-reporter';
const root = mkdtempSync(join(tmpdir(), 'herdr-issue4-'));
const bin='/tmp/herdr-v0.9.1-research';
writeFileSync(join(root,'fixture.c'), '#include <stdio.h>\n#include <string.h>\nint main(void){char b[100];printf("\\033[2J\\033[H\\033]0;Johnny5\\007› \\n");fflush(stdout);while(fgets(b,sizeof(b),stdin)){if(strncmp(b,"blocked",7)==0)printf("\\033]0;[ ! ] Action Required | Johnny5\\007");else if(strncmp(b,"working",7)==0)printf("\\033]0;⠋ Johnny5\\007");else printf("\\033]0;Johnny5\\007\\033[2J\\033[H› \\n");fflush(stdout);}return 0;}');
const compile=spawnSync('gcc',[join(root,'fixture.c'),'-o',join(root,'letta')],{encoding:'utf8'});if(compile.status!==0)throw Error(compile.stderr);
const env:any = {PATH:process.env.PATH, TERM:'xterm-256color', HOME:root, XDG_CONFIG_HOME:join(root,'config'), XDG_DATA_HOME:join(root,'data'), XDG_STATE_HOME:join(root,'state'), XDG_RUNTIME_DIR:join(root,'run'), SHELL:'/bin/bash', HERDR_CONFIG_PATH:join(root,'config','herdr','config.toml')};
for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR']) mkdirSync(env[key],{recursive:true});
mkdirSync(join(root,'config','herdr'),{recursive:true});
writeFileSync(env.HERDR_CONFIG_PATH, '[update]\nmanifest_check = false\n[ui.sidebar.agents.rows_by_agent]\nletta = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"]]\n');
const session='issue4-runtime';
const output:any[]=[];
const log=(label:string,value:any)=>{output.push({label,value}); console.log(JSON.stringify({label,value}));};
const cli=(...args:string[])=>{const p=spawnSync(bin,['--session',session,...args],{env,encoding:'utf8'});try{return JSON.parse(p.stdout||p.stderr)}catch{return {status:p.status,stdout:p.stdout,stderr:p.stderr}}};
const server=spawn(bin,['--session',session,'server'],{env,cwd:root,stdio:['ignore','pipe','pipe']});
let stderr='';server.stderr.on('data',x=>stderr+=x);
const wait=(ms=150)=>new Promise(r=>setTimeout(r,ms));
try {
 log('environment',{root,session,pid:server.pid,platform:process.platform,arch:process.arch,bun:Bun.version,version:cli('--version')});
 let status:any;
 for(let i=0;i<50;i++){status=cli('status');if(status.result)break;await wait(100);}
 log('status',status); log('workspace-create',cli('workspace','create','--label','research','--cwd',root));
 log('panes',cli('pane','list'));
 const walk=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(p,x.name)):[join(p,x.name)]);
 const socket=walk(root).find(x=>x.endsWith('.sock')&&!x.includes('client'));
 if(!socket)throw Error('No API socket '+walk(root).join(','));
 const panes:any=cli('pane','list'); const pane=panes.result.panes[0].pane_id;
 log('fixture-start',cli('pane','run',pane,`printf '\\033[2J\\033[H\\033]0;Johnny5\\007› \\n'; ${root}/letta`)); await wait(1800);log('fixture-process',cli('pane','process-info','--pane',pane));
 const c=new HerdrClient({env:{enabled:true,socketPath:socket,paneId:pane,binPath:bin},source:'letta-code:mod',agent:'letta-code',displayAgent:'Johnny5'});
 const rpc=async(method:string,params:any)=>c.sendRequest(method,{pane_id:pane,...params});
 const snap=async(label:string)=>{await wait();log(label,cli('pane','get',pane));};
 const native=async(conversation_id='default')=>{const p=spawnSync('/bin/sh',['/root/workspace/herdr/src/integration/assets/letta/herdr-agent-session.sh','session'],{env:{...env,HERDR_ENV:'1',HERDR_SOCKET_PATH:socket,HERDR_PANE_ID:pane,HERDR_BIN_PATH:bin},input:JSON.stringify({conversation_id,agent_id:'agent-research',is_new_session:false}),encoding:'utf8'});log('native-hook',{conversation_id,status:p.status,stdout:p.stdout,stderr:p.stderr});};
 await native();await snap('native-default-first');
 for(const state of ['working','blocked','idle']){cli('pane','send-text',pane,state);cli('pane','send-keys',pane,'enter');await wait(2200);await snap('native-screen-'+state);log('native-screen-explain-'+state,cli('agent','explain',pane,'--json'));}
 for(const [id,start] of [['conv-B','resume'],['conv-C','new'],['default:agent-B','new']]){log('native-switch-'+id,await rpc('pane.report_agent_session',{source:'herdr:letta',agent:'letta',agent_session_id:id,session_start_source:start,seq:Date.now()*1000000+10000}));await snap('native-switch-result-'+id);}
 log('mod-working',await c.reportAgent({state:'working',seq:100,agentSessionId:'default'}));
 log('mod-metadata',await c.reportMetadata({seq:100,customStatus:'thinking',stateLabels:{working:'thinking'}}));await snap('native-then-mod');
 await native();await snap('mod-then-native-default');
 log('release',await c.releaseAgent({seq:101,agentSessionId:'default'}));await snap('release-after-native');
 await native('conv-research');await snap('native-named');
 log('clear-authority',await c.clearAgentAuthority({seq:102}));await snap('clear-after-native');
 log('metadata-existing-client',await c.reportMetadata({seq:103,customStatus:'metadata-only'}));await snap('metadata-existing-client-guard');
 log('metadata-canonical',await rpc('pane.report_metadata',{source:'research:metadata',agent:'letta',display_agent:'Johnny5',seq:1}));await snap('metadata-canonical-display');
 log('metadata-wrong-agent',await rpc('pane.report_metadata',{source:'wrong:metadata',agent:'claude',display_agent:'WRONG',tokens:{summary:'unguarded'},seq:1}));await snap('metadata-wrong-agent-guard');
 log('metadata-wrong-source',await rpc('pane.report_metadata',{source:'source:metadata',agent:'letta',applies_to_source:'no-such-source',display_agent:'WRONGSOURCE',seq:1}));await snap('metadata-source-guard');
 log('cleanup-both-display-clear',await c.reportMetadata({seq:104,clearSummary:true,clearStateLabels:true,clearDisplayAgent:true}));await snap('cleanup-precedence');
 log('metadata-other-summary',await rpc('pane.report_metadata',{source:'other:metadata',tokens:{summary:'other-value'},seq:1}));
 log('metadata-clear-other-summary',await c.reportMetadata({seq:105,clearSummary:true,clearDisplayAgent:true}));await snap('shared-summary-cleared');
 log('mod-after-clear',await c.reportAgent({state:'working',seq:200,agentSessionId:'conv-mod'}));
 log('stale-mod',await c.reportAgent({state:'blocked',seq:199,agentSessionId:'conv-old'}));await snap('stale-mod-result');
 log('equal-mod',await c.reportAgent({state:'idle',seq:200}));await snap('equal-mod-result');
 log('invalid-state',await rpc('pane.report_agent',{source:'invalid',agent:'letta',state:'bogus',seq:1}));
 const bad=new HerdrClient({env:{enabled:true,socketPath:socket,paneId:'w999:p999',binPath:bin}});
 const reporter=new HerdrStateReporter(bad); log('reporter-rejected',await reporter.report('working','thinking','default')); log('reporter-rejected-snapshot',reporter.snapshot());log('reporter-retry-dedup',await reporter.report('working','thinking','default'));
 await native('conv-final');await snap('native-final');
 const r=new HerdrStateReporter(c);r.setDisplayAgent('Johnny5');await r.report('working','tool:Read','default');await snap('real-reporter-default-overwrite');log('reporter-clear',await r.clearAuthority());await snap('reporter-clear-snapshot');
 log('agent-explain',cli('agent','explain',pane,'--json'));
 log('foreign-summary-before-clear',await rpc('pane.report_metadata',{source:'foreign-writer',tokens:{summary:'foreign-summary'},seq:1}));await snap('foreign-summary');
 log('unguarded-clear',await rpc('pane.report_metadata',{source:'letta-code:mod:metadata',agent:'letta-code',applies_to_source:'letta-code:mod',tokens:{summary:null},seq:Date.now()*1000+100}));await snap('unguarded-clear-result');
 for(const teardown of ['releaseAgent','clearAgentAuthority'] as const){
 const created=cli('tab','create','--workspace','w1');log('second-tab',created);const p=created.result.root_pane.pane_id;
 log('second-fixture',cli('pane','run',p,`printf '\\033[2J\\033[H\\033]0;Johnny5\\007› \\n'; ${root}/letta`));await wait(1500);
 const m=new HerdrClient({env:{enabled:true,socketPath:socket,paneId:p,binPath:bin},source:'letta-code:mod',agent:'letta-code'});
 log(teardown+'-mod-first',await m.reportAgent({state:'working',seq:100,agentSessionId:'default'}));log(teardown+'-before-native',cli('pane','get',p));
 log(teardown+'-display',await m.reportMetadata({seq:100,displayAgent:'Johnny5'}));log(teardown+'-display-result',cli('pane','get',p));
 if(teardown==='releaseAgent'){
 for(const [source,agent,applies,display] of [['wrong-agent','claude',undefined,'BAD'],['wrong-source','letta','absent','BAD'],['canonical','letta',undefined,'Johnny5-canonical']]){log('guard-'+source,await m.sendRequest('pane.report_metadata',{pane_id:p,source,agent,applies_to_source:applies,display_agent:display,seq:1}));log('guard-result-'+source,cli('pane','get',p));}
 log('clear-canonical',await m.sendRequest('pane.report_metadata',{pane_id:p,source:'canonical',clear_display_agent:true,seq:2}));log('clear-canonical-result',cli('pane','get',p));
 log('sequence-stale',await m.reportAgent({state:'blocked',seq:99}));log('sequence-stale-result',cli('pane','get',p));log('sequence-equal',await m.reportAgent({state:'blocked',seq:100}));log('sequence-equal-result',cli('pane','get',p));
 }
 log(teardown+'-native-second',await m.sendRequest('pane.report_agent_session',{pane_id:p,source:'herdr:letta',agent:'letta',agent_session_id:'default:agent-research',seq:1,session_start_source:'resume'}));log(teardown+'-after-native',cli('pane','get',p));
 log(teardown+'-mod-idle',await m.reportAgent({state:'idle',seq:101}));log(teardown+'-after-idle',cli('pane','get',p));
 log(teardown+'-stale',await m.reportAgent({state:'blocked',seq:99}));log(teardown+'-equal',await m.reportAgent({state:'blocked',seq:101}));
 log(teardown+'-result',await m[teardown]({seq:102}));log(teardown+'-after-teardown',cli('pane','get',p));
 }
 log('config-only-reload',cli('server','reload-config'));
} catch(e){log('failure',String(e));process.exitCode=1;} finally {log('stop-created-server',cli('server','stop'));await wait(300);if(server.exitCode===null)server.kill('SIGTERM');log('server-stderr',stderr);rmSync(root,{recursive:true,force:true});log('cleanup',{rootRemoved:true,onlyCreatedServerStopped:true});writeFileSync('/tmp/herdr-issue4-runtime-results.json',JSON.stringify(output,null,2)+'\n');rmSync(new URL('./runtime-results.json',import.meta.url),{force:true});}
