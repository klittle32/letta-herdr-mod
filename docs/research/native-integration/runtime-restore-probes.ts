// Cold server restart test; fixture executable only, never an authenticated Letta process.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {join} from 'node:path';
const root=mkdtempSync('/tmp/herdr-restore-');
const bin='/tmp/herdr-v0.9.1-research', session='issue4-restore';
const env:any={PATH:root+':'+process.env.PATH,HOME:root,TERM:'xterm-256color',SHELL:'/bin/bash',XDG_CONFIG_HOME:join(root,'config'),XDG_STATE_HOME:join(root,'state'),XDG_DATA_HOME:join(root,'data'),XDG_RUNTIME_DIR:join(root,'run'),HERDR_CONFIG_PATH:join(root,'config','herdr','config.toml')};
for(const k of ['XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR'])mkdirSync(env[k],{recursive:true});
mkdirSync(join(root,'config','herdr'),{recursive:true});
writeFileSync(env.HERDR_CONFIG_PATH,'[update]\nmanifest_check = false\n[session]\nresume_agents_on_restore = true\n');
writeFileSync(join(root,'fixture.c'),'#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(int argc,char**argv){char p[4096];snprintf(p,sizeof(p),"%s/launches.txt",getenv("HOME"));FILE*f=fopen(p,"a");fprintf(f,"pane=%s",getenv("HERDR_PANE_ID"));for(int i=0;i<argc;i++)fprintf(f," | %s",argv[i]);fprintf(f,"\\n");fclose(f);printf("\\033[2J\\033[H› \\n");fflush(stdout);for(;;)sleep(60);return 0;}');
const cc=spawnSync('gcc',[join(root,'fixture.c'),'-o',join(root,'letta')],{encoding:'utf8'});if(cc.status)throw Error(cc.stderr);
const out:any[]=[];const log=(label:string,value:any)=>{out.push({label,value});console.log(JSON.stringify({label,value}));};
const cli=(...args:string[])=>{const p=spawnSync(bin,['--session',session,...args],{env,encoding:'utf8',timeout:5000});try{return JSON.parse(p.stdout||p.stderr)}catch{return {status:p.status,stdout:p.stdout,stderr:p.stderr}}};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let server:ReturnType<typeof spawn>|undefined;
async function start(){server=spawn(bin,['--session',session,'server'],{env,cwd:root,stdio:'ignore'});for(let i=0;i<40;i++){await wait(100);const s=cli('status');if(s.stdout?.includes('status: running'))return;}throw Error('server startup failed');}
async function stop(){log('stop-created',cli('server','stop'));await wait(700);if(server?.exitCode===null){server.kill('SIGTERM');await wait(300);}}
const walk=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(p,x.name)):[join(p,x.name)]);
try{
 await start();log('environment',{root,session,pid:server?.pid,version:cli('--version')});
 const ws=cli('workspace','create','--label','restore-test','--cwd',root);log('workspace',ws);
 const cases=[{pane:ws.result.root_pane.pane_id,conversation_id:'conv-research',agent_id:'agent-named'},...['A','B'].map(x=>({pane:cli('tab','create','--workspace',ws.result.workspace.workspace_id).result.root_pane.pane_id,conversation_id:'default',agent_id:'agent-'+x}))];
 const socket=walk(root).find(x=>x.endsWith('/herdr.sock'))!;
 for(const c of cases){log('launch-initial',cli('pane','run',c.pane,join(root,'letta')));await wait(500);const p=spawnSync('/bin/sh',['/root/workspace/herdr/src/integration/assets/letta/herdr-agent-session.sh','session'],{env:{...env,HERDR_ENV:'1',HERDR_SOCKET_PATH:socket,HERDR_PANE_ID:c.pane,HERDR_BIN_PATH:bin},input:JSON.stringify({...c,is_new_session:false}),encoding:'utf8'});log('native-hook',{...c,status:p.status});}
 await wait(2500);for(const c of cases)log('before-restart',cli('pane','get',c.pane));log('launches-before',readFileSync(join(root,'launches.txt'),'utf8'));
 await stop();log('persisted-files',walk(root).filter(x=>/session|state/.test(x)));
 await start();await wait(5000);log('after-restart-panes',cli('pane','list'));log('launches-after',readFileSync(join(root,'launches.txt'),'utf8'));log('status-after',cli('status'));
}catch(e){log('failure',String(e));process.exitCode=1;}finally{await stop();rmSync(root,{recursive:true,force:true});log('cleanup',{rootRemoved:true});writeFileSync('/tmp/herdr-issue4-restore-results.json',JSON.stringify(out,null,2)+'\n');}
