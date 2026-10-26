/**
 * Deterministic lexical semi-global alignment of successive Soniox transcripts.
 * Implements weighted word-level edit-distance DP with fuzzy character Levenshtein.
 * No LLM, no embeddings, no audio analysis, no timestamp-based merger.
 */
const WORD=/[\p{L}\p{N}\u200c]+/gu;
const LEAD=/^[\s،,.!?؟؛:…\-\u2014]+/u;
const GAP=1.05;
const wordCache=new Map();
const MAX_CACHE=16000;
function norm(s){
  return s.normalize("NFKC").toLocaleLowerCase("fa")
    .replace(/[يى]/gu,"ی").replace(/ك/gu,"ک")
    .replace(/[ۀة]/gu,"ه").replace(/ؤ/gu,"و")
    .replace(/[\u064b-\u065f\u0670\u0640\u200c\u200d]/gu,"");
}
function tokenize(s){
  return Array.from(s.matchAll(WORD),m=>({text:m[0],normal:norm(m[0]),start:m.index,end:m.index+m[0].length}));
}
function similarity(a,b){
  if(a===b)return 1;
  if(!a||!b||Math.abs(a.length-b.length)>3)return 0;
  const key=a+"\u0000"+b;
  if(wordCache.has(key))return wordCache.get(key);
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const next=[i];
    for(let j=1;j<=b.length;j++){
      next.push(Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+Number(a[i-1]!==b[j-1])));
    }
    prev=next;
  }
  const s=Math.max(0,1-prev[b.length]/Math.max(a.length,b.length));
  if(wordCache.size>=MAX_CACHE)wordCache.clear();
  wordCache.set(key,s);
  return s;
}
function reward(a,b){
  const s=similarity(a,b),longest=Math.max(a.length,b.length);
  if(s===1)return longest>=3?3:1.8;
  if(s>=.78&&longest>=4)return 2.25;
  if(s>=.62&&longest>=4)return 1.1;
  return -1.9;
}
/**
 * Recover the most likely suffix/prefix word alignment.
 * Only consider at most 40 words on each side, weighted by physical
 * expected 3-second overlap; require at least two strong word anchors.
 */
export function alignWordOverlap(left,right,{leftSeconds=10,rightSeconds=10,overlapSeconds=3,limit=40}={}){
  const A=tokenize(left),B=tokenize(right);
  if(!A.length||!B.length)return {status:"no_tokens",trim_words:0};
  const ea=A.length*Math.min(1,overlapSeconds/Math.max(0.001,leftSeconds));
  const eb=B.length*Math.min(1,overlapSeconds/Math.max(0.001,rightSeconds));
  const na=Math.min(A.length,Math.max(12,Math.min(limit,Math.ceil(ea*3+8))));
  const nb=Math.min(B.length,Math.max(12,Math.min(limit,Math.ceil(eb*3+8))));
  const a=A.slice(-na),b=B.slice(0,nb),m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(Number.NEGATIVE_INFINITY));
  const path=Array.from({length:m+1},()=>Array(n+1).fill(null));
  for(let i=0;i<=m;i++)dp[i][0]=0;
  for(let j=1;j<=n;j++){dp[0][j]=-GAP*j;path[0][j]="B"}
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){
    const choices=[
      [dp[i-1][j-1]+reward(a[i-1].normal,b[j-1].normal),"M"],
      [dp[i-1][j]-GAP,"A"],
      [dp[i][j-1]-GAP,"B"],
    ];
    let best=choices[0];
    for(let x=1;x<choices.length;x++)if(choices[x][0]>best[0])best=choices[x];
    [dp[i][j],path[i][j]]=best;
  }
  const candidates=[];
  for(let j=1;j<=n;j++){
    let i=m,k=j,aligned=[];
    while(k>0){
      const op=path[i]?.[k];
      if(!op)break;
      if(op==="M"){
        aligned.push({ai:i-1,bj:k-1,sim:similarity(a[i-1].normal,b[k-1].normal)});
        i--;k--;
      }else if(op==="A"){i--}
      else{k--}
    }
    if(k>0||!aligned.length)continue;
    aligned.reverse();
    const strong=aligned.filter(x=>x.sim>=.75);
    const content=strong.filter(x=>a[x.ai].normal.length>=3&&b[x.bj].normal.length>=3);
    if(strong.length<2||content.length<2)continue;
    const coveredA=m-aligned[0].ai;
    const coverage=strong.length/Math.max(1,Math.min(coveredA,j));
    if(coverage<.32)continue;
    let score=dp[m][j]-.08*(Math.abs(coveredA-ea)+Math.abs(j-eb));
    if(j>Math.max(12,eb*2.5))score-=.12*(j-eb*2.5);
    candidates.push({score,j,strong:strong.length,content:content.length,coverage,coveredA});
  }
  if(!candidates.length)return {status:"no_anchors",trim_words:0,expected_words:eb};
  candidates.sort((x,y)=>y.score-x.score||y.content-x.content||y.strong-x.strong||Math.abs(x.j-eb)-Math.abs(y.j-eb));
  const best=candidates[0];
  if(best.score<2||best.score/Math.max(1,best.j)<.18){
    return {status:"low_confidence",trim_words:0,strong:best.strong,score:best.score,expected_words:eb};
  }
  const remaining=right.slice(b[best.j-1].end).replace(LEAD,"").trim();
  return {status:"aligned",trim_words:best.j,strong:best.strong,content:best.content,score:Number(best.score.toFixed(3)),coverage:Number(best.coverage.toFixed(3)),expected_words:Number(eb.toFixed(1)),remaining};
}
export function mergeWordAligned(parts,segments){
  if(!Array.isArray(parts)||parts.length===0)throw Error("Missing segment transcripts");
  if(!Array.isArray(segments)||segments.length!==parts.length)throw Error("Segment plan mismatch");
  let text=String(parts[0].text??"").trim();
  if(!text)throw Error("First transcript is empty");
  const seams=[];
  for(let i=1;i<parts.length;i++){
    const left=String(parts[i-1].text??"").trim(),right=String(parts[i].text??"").trim();
    if(!right)throw Error("Empty Soniox transcript at segment "+(i+1));
    const prev=segments[i-1],cur=segments[i];
    const overlap=Math.max(0,prev.end_seconds-cur.start_seconds);
    const match=alignWordOverlap(left,right,{
      leftSeconds:prev.duration_seconds,rightSeconds:cur.duration_seconds,overlapSeconds:overlap,
    });
    const remainder=match.status==="aligned"?match.remaining:right;
    if(remainder)text+=" "+remainder;
    seams.push({left_part:i,right_part:i+1,method:"classical_word_dp",status:match.status,matched_words:match.trim_words,score:match.score??null,needs_review:match.status!=="aligned"});
  }
  return {text,seams,unmatched:seams.filter(s=>s.needs_review).length,method:"classical_word_dp"};
}
