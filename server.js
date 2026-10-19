import express from "express";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const app=express();
app.use(express.json({limit:"5mb"}));
app.use(express.static("public"));
const PORT=process.env.PORT||3000;
const OUT=path.resolve("output");

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeName=s=>(s||"site").toLowerCase().replace(/https?:\/\//,"").replace(/[^a-z0-9._-]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,90)||"site";

function absolute(v,base){
  try{
    const u=new URL(v,base);
    return /^https?:$/.test(u.protocol)?u.href:null;
  }catch{return null}
}
function sameOrigin(a,b){
  try{return new URL(a).origin===new URL(b).origin}catch{return false}
}
function localPath(remote,root){
  const u=new URL(remote), r=new URL(root);
  let p=decodeURIComponent(u.pathname||"/");
  if(p==="/"||p.endsWith("/"))p+="index.html";
  else if(!path.extname(p))p+=".html";
  p=p.replace(/^\/+/,"");
  if(u.search){
    const h=crypto.createHash("sha1").update(u.search).digest("hex").slice(0,10);
    const ext=path.extname(p);
    p=ext?p.slice(0,-ext.length)+"."+h+ext:p+"."+h;
  }
  if(u.origin!==r.origin)p="_external/"+safeName(u.hostname)+"/"+p;
  return p;
}

async function saveResource(url,body){
  const rel=localPath(url,START_URL);
  const dest=path.join(OUT,rel);
  await fs.mkdir(path.dirname(dest),{recursive:true});
  await fs.writeFile(dest,body);
  return rel;
}

let START_URL="";

async function cloneSite(opts, progress){
  START_URL=opts.url;
  await fs.rm(OUT,{recursive:true,force:true});
  await fs.mkdir(OUT,{recursive:true});

  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({
    viewport:{width:1440,height:1000},
    userAgent:"Mozilla/5.0 (WebToGitHubCloner/2.0)"
  });

  const maxPages=Math.min(Math.max(Number(opts.maxPages)||50,1),500);
  const maxDepth=Math.min(Math.max(Number(opts.maxDepth)||3,0),10);
  const root=new URL(opts.url);
  const queue=[{url:root.href,depth:0}];
  const seen=new Set();
  const savedPages=[];
  const resources=new Map();
  const errors=[];
  let pageNo=0;

  const allowed=u=>{
    if(sameOrigin(u,root.href))return true;
    if(opts.includeSubdomains){
      try{return new URL(u).hostname.endsWith("."+root.hostname)}catch{return false}
    }
    return false;
  };

  async function captureResponse(response){
    try{
      const u=response.url();
      if(!/^https?:$/.test(new URL(u).protocol))return;
      const type=response.request().resourceType();
      const ct=(response.headers()["content-type"]||"").toLowerCase();
      const interesting=["document","stylesheet","script","image","media","font","manifest","texttrack","other"].includes(type)
        || /image|video|audio|font|css|javascript|json|pdf|xml/.test(ct);
      if(!interesting)return;
      if(resources.has(u))return;
      const body=await response.body();
      resources.set(u,{body,ct,type});
    }catch{}
  }

  while(queue.length && savedPages.length<maxPages){
    const item=queue.shift();
    const clean=new URL(item.url); clean.hash="";
    const url=clean.href;
    if(seen.has(url)||item.depth>maxDepth)continue;
    seen.add(url); pageNo++;
    progress({kind:"page",current:pageNo,max:maxPages,url,depth:item.depth});

    const page=await context.newPage();
    page.on("response",captureResponse);

    try{
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
      await page.waitForLoadState("networkidle",{timeout:15000}).catch(()=>{});

      // Scroll progressively so lazy-loaded media is requested.
      for(let i=0;i<6;i++){
        await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
        await sleep(350);
      }
      await page.evaluate(()=>window.scrollTo(0,0));
      await sleep(700);

      const html=await page.content();
      const title=await page.title().catch(()=> "");
      const links=await page.locator("a[href]").evaluateAll(as=>as.map(a=>a.href).filter(Boolean)).catch(()=>[]);
      const frameUrls=await page.locator("iframe[src]").evaluateAll(es=>es.map(e=>e.src).filter(Boolean)).catch(()=>[]);

      const allLinks=[...links,...frameUrls];
      for(const link of allLinks){
        try{
          const u=new URL(link);u.hash="";
          if(allowed(u.href)&&item.depth<maxDepth)queue.push({url:u.href,depth:item.depth+1});
        }catch{}
      }

      savedPages.push({url,html,title,depth:item.depth});
      await page.close();
    }catch(e){
      errors.push({url,error:String(e.message||e)});
      await page.close().catch(()=>{});
    }
  }

  // Give late network requests a moment to settle.
  await sleep(1000);
  await browser.close();

  // Also parse URLs explicitly present in captured HTML.
  for(const p of savedPages){
    const $=cheerio.load(p.html);
    const attrs=[
      ["img","src"],["img","srcset"],["source","src"],["source","srcset"],
      ["video","src"],["video","poster"],["audio","src"],["script","src"],
      ["link","href"],["iframe","src"],["object","data"],["track","src"]
    ];
    for(const [sel,attr] of attrs){
      $(sel).each((_,el)=>{
        const v=$(el).attr(attr);if(!v)return;
        const vals=attr==="srcset"?v.split(",").map(x=>x.trim().split(/\s+/)[0]):[v];
        for(const x of vals){
          const a=absolute(x,p.url);
          if(a)resources.set(a,resources.get(a)||null);
        }
      });
    }
  }

  progress({kind:"resources",count:resources.size});

  // Write resources captured by Playwright.
  const resourceMap=new Map();
  for(const [remote,data] of resources){
    try{
      let body=data?.body;
      if(!body){
        // Resources present in markup but not requested can be fetched through the page.
        const pg=await context.newPage();
        const resp=await pg.request.get(remote,{timeout:20000});
        if(resp.ok())body=await resp.body();
        await pg.close();
      }
      if(!body)continue;
      const rel=await saveResource(remote,body);
      resourceMap.set(remote,rel);
    }catch(e){
      errors.push({url:remote,error:"resource: "+String(e.message||e)});
    }
  }

  // Rewrite every captured page to local assets/pages.
  for(const p of savedPages){
    const $=cheerio.load(p.html);
    const pageRel=localPath(p.url,START_URL);
    const dest=path.join(OUT,pageRel);
    await fs.mkdir(path.dirname(dest),{recursive:true});

    const rewriteAttr=(el,attr)=>{
      const raw=$(el).attr(attr);if(!raw)return;
      const a=absolute(raw,p.url);
      if(a&&resourceMap.has(a)){
        let rel=path.relative(path.dirname(dest),path.join(OUT,resourceMap.get(a))).replaceAll(path.sep,"/");
        $(el).attr(attr,rel.startsWith(".")?rel:"./"+rel);
      }
    };

    for(const [sel,attr] of [["img","src"],["video","src"],["video","poster"],["audio","src"],["source","src"],["script","src"],["link","href"],["iframe","src"],["object","data"],["track","src"]]){
      $(sel).each((_,el)=>rewriteAttr(el,attr));
    }
    $("img[srcset],source[srcset]").each((_,el)=>{
      const raw=$(el).attr("srcset");if(!raw)return;
      const out=raw.split(",").map(part=>{
        const bits=part.trim().split(/\s+/);
        const a=absolute(bits[0],p.url);
        if(a&&resourceMap.has(a)){
          bits[0]=path.relative(path.dirname(dest),path.join(OUT,resourceMap.get(a))).replaceAll(path.sep,"/");
          if(!bits[0].startsWith("."))bits[0]="./"+bits[0];
        }
        return bits.join(" ");
      }).join(", ");
      $(el).attr("srcset",out);
    });

    $("a[href]").each((_,el)=>{
      const a=absolute($(el).attr("href"),p.url);if(!a||!sameOrigin(a,START_URL))return;
      const u=new URL(a);const target=localPath(u.href,START_URL);
      let rel=path.relative(path.dirname(dest),path.join(OUT,target)).replaceAll(path.sep,"/");
      if(!rel.startsWith("."))rel="./"+rel;
      $(el).attr("href",rel+(u.hash||""));
    });

    // Remove CSP that would block local execution in the offline clone.
    $("meta[http-equiv]").each((_,el)=>{
      if(String($(el).attr("http-equiv")).toLowerCase()==="content-security-policy")$(el).remove();
    });

    await fs.writeFile(dest,"<!doctype html>\n"+$.html(),"utf8");
  }

  const manifest={
    version:"2.0.0",
    source:START_URL,
    createdAt:new Date().toISOString(),
    pages:savedPages.map(p=>({url:p.url,title:p.title,depth:p.depth})),
    resources:[...resourceMap.keys()],
    downloadedResources:resourceMap.size,
    errors,
    note:"Only publicly accessible content was captured. Authentication, subscription/paywall bypass and private content are not circumvented."
  };
  await fs.writeFile(path.join(OUT,"CLONE-MANIFEST.json"),JSON.stringify(manifest,null,2),"utf8");
  await fs.writeFile(path.join(OUT,".nojekyll"),"","utf8");

  return {pages:savedPages.length,resources:resourceMap.size,errors:errors.length};
}

async function gh(url,token,options={}){
  const r=await fetch(url,{...options,headers:{
    Authorization:`Bearer ${token}`,
    Accept:"application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28",
    ...(options.headers||{})
  }});
  const txt=await r.text();let d;try{d=JSON.parse(txt)}catch{d=txt}
  if(!r.ok)throw new Error(`GitHub ${r.status}: ${d?.message||txt}`);
  return d;
}

async function publish({token,owner,repo,description,isPrivate}){
  const existing=await gh(`https://api.github.com/repos/${owner}/${repo}`,token).catch(()=>null);
  if(!existing){
    await gh("https://api.github.com/user/repos",token,{method:"POST",body:JSON.stringify({
      name:repo,description:description||"Cloned website",private:!!isPrivate,auto_init:true
    })});
  }
  const files=[];
  async function walk(dir,base=""){
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      const f=path.join(dir,e.name),r=path.join(base,e.name);
      if(e.isDirectory())await walk(f,r);else files.push([r.replaceAll(path.sep,"/"),await fs.readFile(f)]);
    }
  }
  await walk(OUT);
  const blobs=[];
  for(const [p,b] of files){
    const x=await gh(`https://api.github.com/repos/${owner}/${repo}/git/blobs`,token,{
      method:"POST",body:JSON.stringify({content:b.toString("base64"),encoding:"base64"})
    });
    blobs.push({path:p,mode:"100644",type:"blob",sha:x.sha});
  }
  const info=await gh(`https://api.github.com/repos/${owner}/${repo}`,token);
  const branch=info.default_branch||"main";
  const ref=await gh(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,token);
  const commit0=await gh(`https://api.github.com/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,token);
  const tree=await gh(`https://api.github.com/repos/${owner}/${repo}/git/trees`,token,{method:"POST",body:JSON.stringify({base_tree:commit0.tree.sha,tree:blobs})});
  const commit=await gh(`https://api.github.com/repos/${owner}/${repo}/git/commits`,token,{method:"POST",body:JSON.stringify({message:"Clone website with Playwright",tree:tree.sha,parents:[commit0.sha]})});
  await gh(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,token,{method:"PATCH",body:JSON.stringify({sha:commit.sha,force:false})});
  return {repo:`https://github.com/${owner}/${repo}`,commit:commit.sha,files:files.length};
}

app.post("/api/clone",async(req,res)=>{
  try{
    const url=String(req.body.url||"").trim();
    if(!/^https?:\/\//i.test(url))throw new Error("La URL debe comenzar con http:// o https://");
    const result=await cloneSite({
      url,maxPages:req.body.maxPages,maxDepth:req.body.maxDepth,
      includeSubdomains:!!req.body.includeSubdomains
    },x=>console.log(x));
    res.json(result);
  }catch(e){res.status(400).json({error:String(e.message||e)})}
});
app.post("/api/publish",async(req,res)=>{
  try{
    if(!req.body.token||!req.body.owner||!req.body.repo)throw new Error("Faltan datos de GitHub.");
    const repo=safeName(req.body.repo);
    res.json(await publish({token:req.body.token,owner:req.body.owner,repo,description:req.body.description,isPrivate:!!req.body.isPrivate}));
  }catch(e){res.status(400).json({error:String(e.message||e)})}
});
app.listen(PORT,()=>console.log(`http://localhost:${PORT}`));
