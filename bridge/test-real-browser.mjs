import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
import worker from "./worker.mjs";

const exec=promisify(execFile);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"dexa-status-chrome-"));
const srv=http.createServer(async (req,res)=>{
  try{
    const url="http://127.0.0.1:"+srv.address().port+req.url;
    const r=await worker.fetch(new Request(url,{method:req.method}));
    res.writeHead(r.status,Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end("test server error");}
});
await new Promise(resolve=>srv.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+srv.address().port+"/";
try{
  const browser=process.env.CHROME_BIN||"chromium";
  const args=["--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu",
    "--disable-background-networking","--no-first-run","--no-default-browser-check",
    "--user-data-dir="+dir,"--virtual-time-budget=10000","--dump-dom",url];
  let html="";
  for(let attempt=1;attempt<=2;attempt++){
    const result=await exec(browser,args,{timeout:40000,maxBuffer:10*1024*1024});
    html=result.stdout;
    const match=html.match(/<div[^>]*id="dexa-failover-browser-status"[^>]*>/);
    console.log("CHROME ATTEMPT",attempt,"BADGE",match?match[0].slice(0,300):"not found");
    if(/<div[^>]*id="dexa-failover-browser-status"[^>]*data-state="ready"/.test(html)){
      console.log("PASS REAL CHROMIUM: primary page service worker installed and status badge READY");
      process.exitCode=0;
      break;
    }
    if(attempt===2){
      console.error("Not ready in headless virtual-time browser; inspect state without claiming success");
      process.exitCode=1;
    }
  }
}finally{
  await new Promise(resolve=>srv.close(resolve));
  fs.rmSync(dir,{recursive:true,force:true});
}