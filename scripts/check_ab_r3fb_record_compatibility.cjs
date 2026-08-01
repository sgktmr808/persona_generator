// [R3-FC] R3-FB が作った既存記録(defaultCondition 無し)を、R3-FC が**移行なし**で
//  読めるかを実ブラウザで確かめる。合成パッケージ・合成記録だけを使い、実験の実データは扱わない。
"use strict";
const fs=require("node:fs"),http=require("node:http"),os=require("node:os"),path=require("node:path");
const crypto=require("node:crypto"),{spawn}=require("node:child_process");
const ROOT="/Users/sgktmr/persona_generator";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sha=t=>crypto.createHash("sha256").update(Buffer.from(t,"utf8")).digest("hex");
function ct(f){return f.endsWith(".html")?"text/html; charset=utf-8":"application/octet-stream";}
function server(){return http.createServer((q,s)=>{const t=path.resolve(ROOT,"."+(q.url==="/"?"/index.html":q.url.split("?")[0]));
 if(!t.startsWith(ROOT)||!fs.existsSync(t)){s.writeHead(404);s.end();return;}
 s.writeHead(200,{"content-type":ct(t),"cache-control":"no-store"});fs.createReadStream(t).pipe(s);});}
function waitWs(c){return new Promise((res,rej)=>{let e="",s=false;const t=setTimeout(()=>{if(!s){s=true;rej(new Error("timeout"));}},15000);
 c.stderr.on("data",d=>{e+=d;const m=e.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m&&!s){s=true;clearTimeout(t);res(m[1]);}});});}
class Cdp{constructor(u){this.i=1;this.p=new Map();this.ws=new WebSocket(u);
 this.ready=new Promise((r,j)=>{this.ws.addEventListener("open",r,{once:true});this.ws.addEventListener("error",j,{once:true});});
 this.ws.addEventListener("message",ev=>{const m=JSON.parse(typeof ev.data==="string"?ev.data:Buffer.from(ev.data).toString());
 if(!m.id||!this.p.has(m.id))return;const q=this.p.get(m.id);this.p.delete(m.id);m.error?q.reject(new Error(m.error.message)):q.resolve(m.result);});}
 async send(me,pa={},si=null){await this.ready;const id=this.i++;const pl={id,method:me,params:pa};if(si)pl.sessionId=si;
 const pr=new Promise((r,j)=>this.p.set(id,{resolve:r,reject:j}));this.ws.send(JSON.stringify(pl));return pr;}close(){this.ws.close();}}

function defText(p){return JSON.stringify({experiment:p.experiment,policy:p.policy,exportTargets:p.exportTargets,cases:p.cases});}
function pkgFixture(){
  const ins="【合成】ダミー追加文。";
  const cases=[1].map(n=>{const head=`合成 ${n} 行A\n合成 ${n} 行B`;const a=head+`\n合成 ${n} 末尾`;
    const off=head.length;const b=a.slice(0,off)+"\n"+ins+a.slice(off);
    const st={schema:"t9_gen_settings.v1",salt:"fx"+n};
    return {sourceNo:n,baselineGenerationId:"gen-fx-p001",role:"r",species:"s",reason:"fx",batchId:"fxb",no:n,
      settings:st,settingsRaw:JSON.stringify(st),baselinePromptSha256:sha(a),
      arms:{A:{generationId:"fx-p001-A",role:"control",prompt:a,promptSha256:sha(a),treatmentApplied:false},
            B:{generationId:"fx-p001-B",role:"treatment",prompt:b,promptSha256:sha(b),treatmentApplied:true,insertOffset:off,anchorLine:`合成 ${n} 行B`}}};});
  const body={schemaVersion:"persona-experiment-package.v1",generatedAt:"2026-08-01T00:00:00.000Z",generatedBy:"fixture",
    experiment:{experimentId:"fx",hypothesis:"h",insertionPoint:"p",insertText:ins,insertTextSha256:sha(ins),holdConstant:[],evaluationFocus:[]},
    policy:{arms:[{id:"A",role:"control",label:"A"},{id:"B",role:"treatment",label:"B"}],maxImagesPerArm:5,
      verdicts:["accept","hold","reject"],scoreKeys:["aestheticSatisfaction","intentMatch"],scoreMin:1,scoreMax:5,
      failureCodes:["composition","anatomy","other"],preferences:["A","B","tie"],seedSupport:["supported","unsupported"],
      adoptionDecision:"not-applicable",rankImpliesAdoption:false},
    exportTargets:{reviewSchemaVersion:"persona-prompt-review.v2",experimentSchemaVersion:"persona-facial-fusion-ab.v1"},
    cases};
  body.definitionSha256=sha(defText(body));
  body.integrity={algorithm:"sha256",value:sha(JSON.stringify(body))};
  return body;
}

// R3-FB が保存していた形(defaultCondition 無し・conditions 行あり)
function legacyRecord(pkg){
  return {pkg,conditions:[{conditionId:"abcond-old",experimentId:"fx",caseKey:"p1",sourceNo:1,
      provider:"legacy-provider",model:"legacy-model",seedSupport:"supported",imageSeed:"999",supersedes:null,ts:"2026-08-01T00:00:00.000Z"}],
    images:[{imageId:"fx-p001-A-img-old",experimentId:"fx",caseKey:"p1",sourceNo:1,arm:"A",armRole:"control",
      armGenerationId:"fx-p001-A",baselineGenerationId:"gen-fx-p001",conditionId:"abcond-old",rank:1,
      metadata:{name:"old.png",type:"image/png",size:10,lastModified:1,sha256:"a".repeat(64)},ts:"2026-08-01T00:01:00.000Z"}],
    reviews:[{reviewId:"abrev-old",imageId:"fx-p001-A-img-old",verdict:"hold",
      scores:{aestheticSatisfaction:3,intentMatch:2},failures:["anatomy"],notes:"旧記録",supersedes:null,ts:"2026-08-01T00:02:00.000Z"}],
    comparisons:[],invalidations:[]};
}

(async()=>{
  const pkg=pkgFixture(); const legacy=legacyRecord(pkg);
  const srv=server(); await new Promise(r=>srv.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${srv.address().port}`;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fccompat-"));
  const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
    "--remote-debugging-port=0",`--user-data-dir=${dir}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
  let c=null;
  try{
    c=new Cdp(await waitWs(chrome));
    const t=await c.send("Target.createTarget",{url:base+"/"});
    const a=await c.send("Target.attachToTarget",{targetId:t.targetId,flatten:true});
    const s=a.sessionId;
    await c.send("Runtime.enable",{},s); await c.send("Page.enable",{},s);
    await wait(1200);
    // R3-FB 相当の記録を先に置く
    await c.send("Runtime.evaluate",{expression:`localStorage.setItem("personaGenerator.abExperiment.v1", ${JSON.stringify(JSON.stringify(legacy))})`},s);
    await c.send("Page.reload",{},s); await wait(1800);
    const r=await c.send("Runtime.evaluate",{expression:`(async()=>{
      const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
      const byId=(i)=>document.getElementById(i);
      byId("abTab").click();
      for(let i=0;i<60 && byId("abWorkbench").hidden;i++) await wait(100);
      const out={workbenchShown: !byId("abWorkbench").hidden, setupShown: !byId("abSetup").hidden};
      out.provider=byId("abProvider").value;
      out.state=byId("abCaseState").textContent;
      out.chipA=byId("abChipA").textContent;
      out.promptA=byId("abPromptA").value;
      out.reviewVerdict=byId("abRevA_verdict")?byId("abRevA_verdict").value:null;
      out.reviewNotes=byId("abRevA_notes")?byId("abRevA_notes").value:null;
      out.anatomy=byId("abRevA_failures")?byId("abRevA_failures").querySelector('[data-ab-failure-code="anatomy"]').querySelector("input").checked:null;
      const stored=JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
      out.imagesKept=stored.images.length; out.reviewsKept=stored.reviews.length;
      out.conditionsKept=stored.conditions.length;
      out.inferredDefault=stored.defaultCondition?stored.defaultCondition.imageSeed:null;
      return out;})()`,awaitPromise:true,returnByValue:true,timeout:60000},s);
    if(r.exceptionDetails){console.log("EXCEPTION",JSON.stringify(r.exceptionDetails.exception));process.exit(1);}
    const v=r.result.value;
    const expectPrompt=pkg.cases[0].arms.A.prompt;
    const checks=[
      ["作業台が出る", v.workbenchShown===true],
      ["生成元の再入力を求めない(既存 condition から引き継ぐ)", v.setupShown===false],
      ["既存 condition から default を推定", v.inferredDefault==="999"],
      ["既存画像を保持", v.imagesKept===1],
      ["既存レビューを保持", v.reviewsKept===1],
      ["既存 condition 行を保持", v.conditionsKept===1],
      ["本文が変わらない", v.promptA===expectPrompt],
      ["状態は Aのみ", v.state==="Aのみ"],
      ["既存レビューを載せ直す(判定)", v.reviewVerdict==="hold"],
      ["既存レビューを載せ直す(コメント)", v.reviewNotes==="旧記録"],
      ["既存レビューを載せ直す(失敗分類)", v.anatomy===true],
    ];
    let ok=true;
    checks.forEach(([n,p])=>{ if(!p){console.log("NG:",n);ok=false;} });
    console.log(JSON.stringify(v));
    console.log(`OK: R3-FB 記録の移行なし読み込み ${checks.length} 件`);
    console.log(ok?"PASS":"FAIL");
    process.exit(ok?0:1);
  } finally { if(c)c.close(); chrome.kill("SIGTERM"); await wait(400); srv.close(); fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exit(1);});
