/** Exact challenge prompts through DSH UI with isolated, synthetic dated history.
 * Calendar fixtures target November 12, 2026; update dates before later replays.
 * This diagnostic captures answers for semantic review, not an automatic pass score.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { MemoryStore } from '../plugin/src/memory.ts'
import { runSearchBatch } from '../plugin/src/report.ts'
const root=path.resolve(import.meta.dirname,'..')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'minimi-challenge-'))
const output=path.join(root,'data/challenge-browser')
fs.mkdirSync(output,{recursive:true})
const cases=JSON.parse(fs.readFileSync(path.join(root,'evals/golden-v2/cases.json')))
const crm=cases.find(c=>c.id==='h01'),pg=cases.find(c=>c.id==='d02')
const history=[...crm.history,...pg.history].map(h=>structuredClone(h))
const pine=history.find(h=>h.id==='pg-nov10')
pine.assistant='PineDB US Launch is $15 USD/month on monthly billing. We shortlisted only PineDB in this November 10 comparison.'
pine.evidence=[{id:'pine-old',url:'https://pine-old.example/pricing',title:'PineDB previous price',excerpt:'PineDB Launch in the US costs $15 USD/month, monthly billing.'}]
const current=[...crm.search_fixtures,...pg.search_fixtures,{id:'pine-current',url:'https://pine-current.example/pricing',title:'PineDB current price',excerpt:'PineDB Launch in the US costs $18 USD/month, monthly billing. Effective November 11, 2026.'}]
const rows=current.map(f=>({title:f.title,url:f.url,summary:f.excerpt,snippet:'',date:'2026-11-12T00:00:00Z',authority:4,rerank_score:3}))
const fixtureDir=path.join(tmp,'fixtures');fs.mkdirSync(fixtureDir)
fs.writeFileSync(path.join(fixtureDir,'search.json'),JSON.stringify({'*':rows}))
fs.writeFileSync(path.join(fixtureDir,'fetch.json'),JSON.stringify(Object.fromEntries(current.map(f=>[f.url,{title:f.title,content:f.excerpt}]))))
const dbFile=path.join(tmp,'memory.db'),store=new MemoryStore(dbFile)
for(const h of history){
 const now=Date.parse(h.timestamp),sid='challenge-'+h.thread_id
 store.beginTurn(sid,1,'Asia/Kolkata',now);store.setUser(sid,1,h.user,'Asia/Kolkata');store.setAssistant(sid,1,h.assistant,false)
 for(const e of h.evidence??[]){
  const subject=e.excerpt.match(/^(\w+)/)?.[1]
  const r={title:e.title,url:e.url,summary:e.excerpt,snippet:'',date:h.timestamp,authority:4,rerankScore:3}
  await runSearchBatch({queries:[{query:subject+' historical pricing',subject}],intent:'answer'},{store,sessionId:sid,turn:1,tz:'Asia/Kolkata',now,signal:new AbortController().signal,onAttempt:()=>{},maxQueries:3,search:async()=>({results:[r],attempts:1,fetched:0}),fetch:async()=>({title:e.title,content:e.excerpt,attempts:1})})
 }
}
const baselineSnapshots=store.snapshotCount();store.close()
fs.mkdirSync(path.join(tmp,'dsh'),{recursive:true})
fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'dsh','node_modules'),'dir')
let server,browser
const results={mode:'Live DeepSeek model and real DSH browser; synthetic dated memory and search/fetch fixtures; actual clock November 12, 2026',baselineSnapshots,cases:[]}
try {
 let buffer=''
 server=spawn(process.execPath,['scripts/dev.mjs','--no-open'],{cwd:root,env:{...process.env,MINIMI_PORT:'0',PORT:'0',MINIMI_NO_OPEN:'1',MINIMI_DSH_HOME:path.join(tmp,'dsh'),MINIMI_DB:dbFile,MINIMI_SEARCH_FIXTURES:fixtureDir,MINIMI_DEFAULT_TZ:'Asia/Kolkata',MINIMI_OBSERVABILITY:'0'},stdio:['ignore','pipe','pipe']})
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('DSH startup timeout')),90000); const read=d=>{buffer+=d;const m=/dsh web:\s+(http:\/\/\S+)/.exec(buffer);if(m){clearTimeout(timer);resolve(m[1])}};server.stdout.on('data',read);server.stderr.on('data',read);server.once('exit',code=>{clearTimeout(timer);reject(Error('DSH exited '+code+' '+buffer.replace(/https?:\/\/\S+/g,'[URL]').replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]').slice(-3000)))})})
 browser=await chromium.launch({channel:'chrome',headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 const prompts=["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?","What did I ask you on 3 November? Is your answer still correct today?","Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"]
 for(let i=0;i<prompts.length;i++){
  const page=await context.newPage();await page.goto(url,{waitUntil:'networkidle',timeout:60000})
  const cont=page.getByRole('button',{name:/Continue/i});if(await cont.count())await cont.first().click()
  await page.getByRole('button',{name:'New session',exact:true}).last().click()
  await page.waitForFunction(()=>document.querySelectorAll('[data-chat-group-part="response"]').length===0)
  const prompt=prompts[i],t=Date.now(),box=page.locator('[contenteditable="true"]').first()
  await box.fill(prompt);await box.press('Enter')
  await page.waitForFunction(()=>document.querySelectorAll('[data-turn-tail]').length>0,null,{timeout:180000})
  const response=page.locator('[data-chat-group-part="response"]').last()
  const result={prompt,ms:Date.now()-t,answer:await response.innerText(),links:await response.locator('a[href^="http"]').evaluateAll(as=>as.map(a=>a.href))}
  results.cases.push(result);fs.writeFileSync(path.join(output,'seeded-results.json'),JSON.stringify(results,null,2))
  await page.screenshot({path:path.join(output,`seeded-${i+1}.png`),fullPage:true})
  console.log(JSON.stringify({case:i+1,...result}));await page.close()
 }
 // Save only synthetic test records, never public user conversations.
 const check=new MemoryStore(dbFile)
 results.searches=check.db.prepare('SELECT intent,items,digest,attempts FROM searches WHERE session_id NOT LIKE ?').all('challenge-%')
 results.turns=check.db.prepare('SELECT session_id,turn,user_text,assistant_text FROM turns WHERE session_id NOT LIKE ?').all('challenge-%')
 check.close()
} catch(e){results.error=String(e);console.error(String(e));process.exitCode=1}
finally {fs.writeFileSync(path.join(output,'seeded-results.json'),JSON.stringify(results,null,2));await browser?.close();server?.kill('SIGTERM')}
