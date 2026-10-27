// DX-005: bounded multi-source PUBLIC WEB evidence collection.
// One admitted read-only Rana TOOL. No additional model or site-specific rule.
import {createHash,randomUUID} from "node:crypto";
import {boundedPublicGet,executeDexaWebRead,verifiedPublicHttpsUrl}
 from "./dexa_web_read_v1.mjs";
export const DEXA_WEB_EVIDENCE_ID="web.evidence";
export const DEXA_WEB_EVIDENCE_ROUTE="dexa_web_evidence";
export const DEXA_WEB_EVIDENCE_INPUT_SCHEMA=Object.freeze({
 type:"object",additionalProperties:false,required:["query"],
 properties:{query:{type:"string",minLength:3,maxLength:180},
  maxSources:{type:"integer",minimum:1,maximum:4}}
});
const MAX_PAGE_BYTES=780000,MAX_CANDIDATES=5,MAX_GOOD_PAGES=4;
const MAX_RESULT_CHARS=36000;
const hash=x=>createHash("sha256").update(x).digest("hex");
const fail=code=>Object.assign(new Error(code),{code});
const clean=s=>String(s||"").normalize("NFC")
 .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu," ")
 .replace(/\s+/gu," ").trim();
const decode=s=>String(s).replace(
 /&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp|zwnj|lrm|rlm);/gi,
 (raw,x)=>{
  const table={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",
   zwnj:"\u200c",lrm:" ",rlm:" "};
  if(Object.hasOwn(table,x.toLowerCase()))return table[x.toLowerCase()];
  if(!x.startsWith("#"))return raw;
  const n=/^#x/i.test(x)?parseInt(x.slice(2),16):parseInt(x.slice(1),10);
  return Number.isSafeInteger(n)&&n>0&&n<=0x10ffff?
   String.fromCodePoint(n):raw;
 });
const escapedHtmlText=raw=>{
 let html=raw.replace(/<!--[\s\S]*?-->/g," ")
  .replace(/<(script|style|noscript|svg|iframe|form|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ");
 html=html.replace(/<\s*\/\s*(?:div|p|li|tr|td|th|h[1-6]|article|section|main|header|footer|time|span)\s*>/gi," | ")
  .replace(/<\s*br\s*\/?\s*>/gi," | ")
  .replace(/<[^>]+>/g," ");
 return clean(decode(html)).replace(/(?:\s*\|\s*){2,}/g," | ");
};
export function extractEvidencePage(body,contentType,{query}={}){
 if(!Buffer.isBuffer(body)||body.length>MAX_PAGE_BYTES)
  throw fail("DEXA_WEB_EVIDENCE_PAGE_INVALID");
 let text;
 if(["text/html","application/xhtml+xml"].includes(contentType))
  text=escapedHtmlText(body.toString("utf8"));
 else if(contentType==="application/json"){
  let data;
  try{data=JSON.parse(body.toString("utf8"))}
  catch{throw fail("DEXA_WEB_EVIDENCE_JSON_INVALID")}
  text=clean(JSON.stringify(data));
 }else if(["text/plain","application/xml","text/xml"].includes(contentType))
  text=clean(decode(body.toString("utf8")));
 else throw fail("DEXA_WEB_EVIDENCE_MIME_INVALID");
 if(!text)return {text:"",totalChars:0,quality:"EMPTY"};
 const prefix=text.slice(0,2500);
 const tokens=clean(query).toLocaleLowerCase("fa").split(/[^\p{L}\p{N}]+/u)
  .filter(x=>x.length>=3).slice(0,14);
 const samples=[];
 if(text.length>2500&&tokens.length){
  let highest={score:0,at:0};
  for(let pos=2200;pos<Math.min(text.length,45000);pos+=400){
   const chunk=text.slice(pos,pos+850).toLocaleLowerCase("fa");
   const count=tokens.filter(t=>chunk.includes(t)).length;
   if(count>highest.score)highest={score:count,at:pos};
  }
  if(highest.score>0)samples.push(text.slice(Math.max(0,highest.at-160),highest.at+800));
 }
 const output=clean([prefix,...samples].join(" | ")).slice(0,3600);
 return {text:output,totalChars:text.length,
  quality:text.length<260?"THIN":"SUBSTANTIVE",
  truncated:text.length>output.length};
}
const evidenceSource=(item,kind,data={})=>{
 const p=verifiedPublicHttpsUrl(item.url);
 const readTime=data.readAt||item.observedAt;
 const statement=kind==="PAGE_TEXT"?
  "PUBLIC_PAGE_TEXT: verified HTTPS page retrieval (not independent fact verification)":
  "SEARCH_INDEX_SNIPPET_ONLY: search provider summary; target page not verified";
 const title=clean(item.title).slice(0,180);
 const body=kind==="PAGE_TEXT"?data.pageText:
  clean(item.snippet).slice(0,380);
 const url=p.href;
 const prefix=statement+". URL: "+url+". TITLE: "+title+
  ". OBSERVED: "+readTime+". "+
  (item.publishedAt?"SEARCH_PUBLISHED_AT: "+item.publishedAt+". ":"");
 return Object.freeze({
  kind,sourceUrl:url,title,observedAt:readTime,
  publishedAt:item.publishedAt??null,searchRank:data.rank,
  ...(data.contentDigest?{contentDigest:data.contentDigest}:{}),
  ...(data.pageBytes?{pageBytes:data.pageBytes}:{}),
  ...(data.totalChars?{totalChars:data.totalChars}:{}),
  text:(prefix+"TEXT: "+body).slice(0,2200)
 });
};
export async function executeEvidenceCollection({capabilityId,args},{
 search=executeDexaWebRead,read=boundedPublicGet,
 now=()=>new Date().toISOString()
}={}){
 if(capabilityId!==DEXA_WEB_EVIDENCE_ID||!args||
    typeof args!=="object"||Array.isArray(args)||
    typeof args.query!=="string"||args.query.trim().length<3||
    args.query.length>180||/\p{C}/u.test(args.query)||
    Object.keys(args).some(k=>!["query","maxSources"].includes(k))||
    !Number.isSafeInteger(args.maxSources??3)||
    (args.maxSources??3)<1||(args.maxSources??3)>MAX_GOOD_PAGES)
  throw fail("DEXA_WEB_EVIDENCE_ARGS_INVALID");
 const maxSources=args.maxSources??3,started=Date.now();
 const found=await search({
  capabilityId:"web.search",args:{query:args.query.trim(),maxResults:MAX_CANDIDATES}
 });
 const searchData=found?.result;
 if(searchData?.schema!=="dexa.web-source.v1"||
    searchData?.operation!=="search"||
    searchData?.sourceVerification!=="SOURCE_VERIFIED"||
    !Array.isArray(searchData?.results)||
    searchData.results.length<1||searchData.results.length>MAX_CANDIDATES||
    typeof searchData.contentDigest!=="string"||
    typeof searchData.readAt!=="string")
  throw fail("DEXA_WEB_EVIDENCE_SEARCH_UNVERIFIED");
 const observations=[],pages=[],snippets=[],seenContentDomains=new Set();
 let good=0;
 for(let i=0;i<searchData.results.length;i++){
  const hit=searchData.results[i];
  if(!hit||typeof hit.url!=="string"||typeof hit.title!=="string")
   throw fail("DEXA_WEB_EVIDENCE_SEARCH_MALFORMED");
  const candidate=verifiedPublicHttpsUrl(hit.url),rank=i+1;
  snippets.push(evidenceSource(hit,"SEARCH_SNIPPET",{rank}));
  if(good>=maxSources||pages.length>=MAX_GOOD_PAGES){
   observations.push({rank,status:"NOT_FETCHED_BUDGET",url:candidate.href});
   continue;
  }
  if(seenContentDomains.has(candidate.hostname)){
   observations.push({rank,status:"DOMAIN_ALREADY_OBSERVED",url:candidate.href});
   continue;
  }
  try{
   const response=await read(candidate.href,{maxBytes:MAX_PAGE_BYTES});
   if(typeof response?.url!=="string"||!
      Buffer.isBuffer(response.body)||typeof response.bodyDigest!=="string"||
      typeof response.readAt!=="string")
    throw fail("DEXA_WEB_EVIDENCE_PAGE_UNVERIFIED");
   const actual=verifiedPublicHttpsUrl(response.url);
   const parsed=extractEvidencePage(response.body,response.contentType,{
    query:args.query});
   if(parsed.quality!=="SUBSTANTIVE"){
    observations.push({rank,status:"THIN_PAGE",url:actual.href,
     readAt:response.readAt,contentDigest:response.bodyDigest,
     extractedChars:parsed.totalChars});
    continue;
   }
   seenContentDomains.add(candidate.hostname);
   pages.push(evidenceSource({...hit,url:actual.href},"PAGE_TEXT",{
    readAt:response.readAt,rank,pageText:parsed.text,
    contentDigest:response.bodyDigest,
    pageBytes:response.byteLength,totalChars:parsed.totalChars
   }));good++;
   observations.push({rank,status:"PAGE_SUBSTANTIVE",url:actual.href,
    readAt:response.readAt,contentDigest:response.bodyDigest,
    extractedChars:parsed.totalChars,pageBytes:response.byteLength});
  }catch(error){
   const code=String(error?.code||"DEXA_WEB_EVIDENCE_PAGE_ERROR");
   observations.push({rank,status:"READ_OBSTRUCTED",url:candidate.href,
    errorCode:code.startsWith("DEXA_WEB_")?code:"DEXA_WEB_EVIDENCE_PAGE_ERROR"});
  }
 }
 const sources=[...pages,...snippets.filter(x=>
  !pages.some(y=>y.sourceUrl===x.sourceUrl))].slice(0,MAX_CANDIDATES+MAX_GOOD_PAGES);
 if(!sources.length)throw fail("DEXA_WEB_EVIDENCE_NO_SOURCES");
 const total=Buffer.byteLength(JSON.stringify({sources,observations}));
 if(total>MAX_RESULT_CHARS)
  throw fail("DEXA_WEB_EVIDENCE_OUTPUT_TOO_LARGE");
 return {
  result:Object.freeze({
   schema:"dexa.web-evidence.v1",
   operation:"collect",provider:searchData.provider,
   query:args.query.trim(),sourceVerification:"SOURCE_VERIFIED",
   factVerification:"NOT_INDEPENDENTLY_VERIFIED",
   sourceTrust:"UNTRUSTED_PUBLIC_WEB_DATA",
   sourceCount:sources.length,pageCount:pages.length,
   searchResultCount:searchData.results.length,
   coverageLimited:pages.length<Math.min(maxSources,searchData.results.length),
   sources,observations,searchReceiptId:searchData.receiptId,
   searchSourceUrl:searchData.sourceUrl,
   searchContentDigest:searchData.contentDigest,
   searchObservedAt:searchData.readAt,
   credentialSlot:searchData.credentialSlot,
   sourceDigest:hash(JSON.stringify({sources,observations})),
   readAt:now(),receiptId:randomUUID(),
   maxSources,readOnly:true,effectsExecuted:0
  }),
  providerTool:"DEXA.INTERNAL.dexa_web_evidence",
  durationMs:Date.now()-started
 };
}
