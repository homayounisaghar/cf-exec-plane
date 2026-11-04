import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("./lite-gateway.mjs",import.meta.url),"utf8");
assert.match(source,/const FAILOVER_UI_SCRIPT/);
assert.match(source,/draftScript\+FAILOVER_UI_SCRIPT/);
const segment=source.slice(source.indexOf("const FAILOVER_UI_SCRIPT"),source.indexOf("function rewriteCookie"));
assert.ok(segment.startsWith("const FAILOVER_UI_SCRIPT"));
const context={PREFIX:"/dexa-lite",CSS:""};
vm.createContext(context);
vm.runInContext(segment+"; globalThis.statusHTML=FAILOVER_UI_SCRIPT;globalThis.rewrite=rewriteHTML;",context);
const script=context.statusHTML;
assert.match(script,/id="dexa-browser-failover-status"/);
const sample='<html><head><title>دکسا | اجرای مأموریت</title></head><body>'+
 '<label style="display:flex;align-items:center;gap:9px;margin-top:8px"><input id="telegramMvpMode" type="checkbox"><span>تلگرام (فقط‌خواندنی)</span></label>'+
 '<select><option value="5">۵ عدد</option><option value="15" selected>۱۵ عدد</option></select></body></html>';
const result=context.rewrite(sample);
assert.match(result,/dexa-browser-failover-status/);
assert.match(result,/dexa\.lite\.draft\.v1/);
assert.match(result,/selected>۵ عدد/);

function simulate(hostname,reply){
  const badge={style:{},dataset:{},attributes:{},setAttribute(k,v){this.attributes[k]=v},textContent:""};
  const listeners={};
  const ctx={document:{createElement(){return badge},body:{appendChild(x){assert.equal(x,badge)}}},
    location:{hostname},
    navigator:{serviceWorker:{
      controller:{postMessage(q,ports){assert.equal(q.type,"DEXA_FAILOVER_STATUS_QUERY");queueMicrotask(()=>ports[0].postMessage(reply));}},
      addEventListener(k,f){listeners[k]=f}
    }},
    MessageChannel:class{
      constructor(){
        const a=this.port1={close(){},onmessage:null};
        this.port2={postMessage(d){queueMicrotask(()=>a.onmessage?.({data:d}))}}
      }
    },
    setTimeout,clearTimeout};
  vm.runInNewContext(script.replace(/^<script>/,"").replace(/<\/script>$/,""),ctx);
  return {badge,listeners};
}
const primary="dexa-cf-worker-canary-20261104.mirkazem.workers.dev";
const b="dexa-cf-backup-20261104.mirkazem-design.workers.dev";
const good=simulate(primary,{type:"DEXA_FAILOVER_STATUS",version:"DEXA_CLOUDFLARE_BRIDGE_V1",backupReady:true,backupOrigin:"https://"+b});
await new Promise(r=>setTimeout(r,30));
assert.equal(good.badge.dataset.state,"ready");
const wrong=simulate(primary,{type:"DEXA_FAILOVER_STATUS",version:"DEXA_CLOUDFLARE_BRIDGE_V1",backupReady:true,backupOrigin:"https://wrong.example"});
await new Promise(r=>setTimeout(r,30));
assert.equal(wrong.badge.dataset.state,"off");
const back=simulate(b,{});
assert.equal(back.badge.dataset.state,"backup");
const direct=simulate("cf-onshape.duckdns.org",{});
assert.equal(direct.badge.dataset.state,undefined);
console.log("PASS split UI: correct Worker acknowledgment is green; wrong backup not green; backup blue; direct Hetzner no badge; HTML rewrite preserved");