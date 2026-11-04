import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("./lite-gateway.mjs",import.meta.url),"utf8");
const declaration=source.match(/^const FAILOVER_UI_SCRIPT = (.+);$/m);
assert.ok(declaration,"Badge client JS is defined");
const badgeHTML=vm.runInNewContext(declaration[1]);
const script=badgeHTML.replace(/^<script>/,"").replace(/<\/script>$/,"");
assert.ok(!script.includes("position:fixed"));
assert.ok(!script.includes("document.body.appendChild"));
const segment=source.slice(source.indexOf("function rewriteHTML(html){"),source.indexOf("function rewriteCookie"));
const sandbox={PREFIX:"/dexa-lite",CSS:""};
vm.createContext(sandbox);
vm.runInContext(segment+";globalThis.rewrite=rewriteHTML;",sandbox);
const sample='<html><head><title>دکسا | اجرای مأموریت</title></head><body><header><div class="row dexa-status-header"><h1>دکسا</h1><span class="status" id="serviceStatus">سرویس آماده</span><span class="status waiting" id="instantReadyFlag">Cerebras آماده</span></div></header>'+
'<label style="display:flex;align-items:center;gap:9px;margin-top:8px"><input id="telegramMvpMode" type="checkbox"><span>تلگرام (فقط‌خواندنی)</span></label><select><option value="5">۵ عدد</option><option value="15" selected>۱۵ عدد</option></select></body></html>';
const rewritten=sandbox.rewrite(sample);
assert.ok(rewritten.includes("dexa-browser-failover-status"));
assert.ok(rewritten.includes('selected>۵ عدد'));
assert.ok(!rewritten.includes('id="telegramMvpMode" type="checkbox" checked'));

function testPage(hostname,active=true,reply){
  const badges=[];
  const header={nodes:badges,appendChild(el){badges.push(el);el.parentElement=this}};
  const element={style:{},dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v},textContent:"",className:"",title:""};
  const planner={parentElement:header,insertAdjacentElement(position,el){assert.equal(position,"afterend");badges.push(el);el.parentElement=header}};
  const listeners={};
  let controller=active?{postMessage(msg,ports){
    assert.equal(msg.type,"DEXA_FAILOVER_STATUS_QUERY");
    queueMicrotask(()=>ports[0].postMessage(reply));
  }}:null;
  const sw={get controller(){return controller},set controller(v){controller=v},addEventListener(k,fn){listeners[k]=fn}};
  class MessageChannel{
    constructor(){
      const p=this.port1={onmessage:null,close(){}};
      this.port2={postMessage(value){queueMicrotask(()=>p.onmessage?.({data:value}))}};
    }
  }
  const doc={
    querySelector(q){assert.equal(q,".dexa-status-header");return header},
    getElementById(id){assert.equal(id,"instantReadyFlag");return planner},
    createElement(tag){assert.equal(tag,"span");return element},
    body:{appendChild(){throw Error("No fixed overlay allowed")}}
  };
  vm.runInNewContext(script,{document:doc,location:{hostname},
    navigator:{serviceWorker:sw},MessageChannel,setTimeout,clearTimeout});
  return {badges,element,listeners,sw};
}
const A="dexa-cf-worker-canary-20261104.mirkazem.workers.dev";
const B="dexa-cf-backup-20261104.mirkazem-design.workers.dev";
const good={type:"DEXA_FAILOVER_STATUS",version:"DEXA_CLOUDFLARE_BRIDGE_V1",
  backupReady:true,backupOrigin:"https://"+B};
const page=testPage(A,true,good);
await new Promise(r=>setTimeout(r,30));
assert.equal(page.badges.length,1);
assert.equal(page.element.className,"status success");
assert.equal(page.element.dataset.state,"ready");
assert.equal(page.element.textContent,"انتقال آماده");
assert.equal(page.element.title,"انتقال خودکار آماده است");
assert.equal(page.element.attrs.role,"status");
assert.equal(page.element.style.cssText,"white-space:nowrap;flex:0 0 auto");

const pending=testPage(A,false,good);
assert.equal(pending.element.className,"status waiting");
pending.sw.controller={postMessage(msg,ports){queueMicrotask(()=>ports[0].postMessage(good))}};
pending.listeners.controllerchange();
await new Promise(r=>setTimeout(r,30));
assert.equal(pending.element.className,"status success");

const invalid=testPage(A,true,{...good,backupOrigin:"https://wrong.example"});
await new Promise(r=>setTimeout(r,30));
assert.equal(invalid.element.className,"status failure");
const backup=testPage(B,true,good);
assert.equal(backup.element.className,"status owner-wait");
assert.equal(backup.element.textContent,"حساب پشتیبان");
const other=testPage("cf-onshape.duckdns.org",true,good);
assert.equal(other.badges.length,0);
console.log("PASS topbar status: existing header insertion only, exact SW proof -> success, pending/controllerchange, off, backup, no fixed overlay and HTML rewrite");
