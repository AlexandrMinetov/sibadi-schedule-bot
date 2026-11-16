import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker,{ScheduleBot,fetchWeek,localISO,monitor,handleCommand,sendOnce,dayBlock,messages} from './worker.js';

const realFetch=globalThis.fetch,realNow=Date.now;
afterEach(()=>{globalThis.fetch=realFetch;Date.now=realNow;});
function memory() {
  const values=new Map();
  return {
    values,
    async get(k,o){const r=values.get(k);return r===undefined?null:o?.type==='json'?JSON.parse(r):r;},
    async put(k,v){values.set(k,v);}
  };
}
function env() {return {BOT_TOKEN:'test',CHAT_ID:'-100123',THREAD_ID:'42',WEBHOOK_SECRET:'a'.repeat(64),STATE:memory()};}
const row=(day,subject='Предмет <&>')=>({кодГруппы:14992,датаНачала:day+'T10:00:00',датаОкончания:day+'T11:30:00',дисциплина:subject,номерЗанятия:2,преподаватель:'Учитель',аудитория:'203'});
function services(rows,{rejectSend=false,ambiguous=false,pinFails=false}={}) {
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('umu.sibadi.org'))return Response.json({data:{isCyclicalSchedule:false,rasp:rows}});
    const method=String(url).split('/').at(-1),data=JSON.parse(options.body);
    calls.push({method,data});
    if(method==='sendMessage'&&ambiguous)throw Error('network contains secret');
    if(method==='sendMessage'&&rejectSend)return Response.json({ok:false,error_code:429,parameters:{retry_after:30}},{status:429});
    if(method==='pinChatMessage'&&pinFails)return Response.json({ok:false,error_code:403},{status:403});
    return Response.json({ok:true,result:method==='sendMessage'?{message_id:calls.length+100}:true});
  };
  return calls;
}
const command=(id=1,text='/help',thread=42)=>({update_id:id,message:{message_id:55,date:1794855600,chat:{id:-100123},message_thread_id:thread,text,entities:[{type:'bot_command',offset:0,length:text.length}]}});
const sends=calls=>calls.filter(c=>c.method==='sendMessage');

test('strict local dates and UTC conversion',()=>{
  assert.equal(localISO('2026-11-17T04:00:00Z'),'2026-11-17T10:00:00.000Z');
  assert.equal(localISO('2026-11-17T10:00:00'),'2026-11-17T10:00:00');
  for(const value of ['2026-02-30T10:00:00','2026-11-17T24:00:00','garbage'])assert.throws(()=>localISO(value));
});
test('verified API, HTML escaping, empty and foreign group rejected',async()=>{
  services([row('2026-11-17')]);
  const data=await fetchWeek('2026-11-17');
  assert.equal(data['2026-11-18'].length,0);
  assert.match(messages([dayBlock('2026-11-17',data['2026-11-17'])])[0],/&lt;&amp;&gt;/);
  services([]);await assert.rejects(fetchWeek('2026-11-17'));
  services([{...row('2026-11-17'),кодГруппы:1}]);await assert.rejects(fetchWeek('2026-11-17'));
});
test('commands only in configured topic, addressed bot, duplicates ignored',async()=>{
  const e=env(),calls=services([row('2026-11-17')]);
  await handleCommand(e,command(1,'/help',99));
  await handleCommand(e,command(1,'/help@other_bot'));
  assert.equal(sends(calls).length,0);
  await handleCommand(e,command());await handleCommand(e,command());
  assert.equal(sends(calls).length,1);
  assert.equal(sends(calls)[0].data.message_thread_id,42);
  assert.ok([...e.STATE.values].every(([,v])=>!v.includes('/help')));
});
test('daily at 20 Omsk, imported today preserved, repeated cron idempotent',async()=>{
  Date.now=()=>Date.parse('2026-11-17T14:00:00Z');
  const e=env(),calls=services([row('2026-11-17'),row('2026-11-18')],{pinFails:true});
  await e.STATE.put('active','1');
  const data=await fetchWeek('2026-11-17');
  await e.STATE.put('day:2026-11-17',JSON.stringify({rows:data['2026-11-17'],published:true}));
  await monitor(e);await monitor(e);
  assert.equal(sends(calls).length,1);
  assert.match(sends(calls)[0].data.text,/18.11.2026/);
  assert.equal((await e.STATE.get('day:2026-11-18',{type:'json'})).published,true);
});
test('no tomorrow publication before 20, midnight catch up',async()=>{
  Date.now=()=>Date.parse('2026-11-17T13:59:00Z');
  const e=env(),calls=services([row('2026-11-17'),row('2026-11-18')]);
  await e.STATE.put('active','1');
  await monitor(e);
  assert.equal(sends(calls).length,1);
  assert.match(sends(calls)[0].data.text,/17.11.2026/);
});
test('ambiguous send is not automatically resent, definite rejection can retry',async()=>{
  const e=env(),calls=services([],{ambiguous:true});
  await assert.rejects(sendOnce(e,'daily:test','hello'),e=>!e.message.includes('secret'));
  assert.equal(await sendOnce(e,'daily:test','hello'),null);
  assert.equal(sends(calls).length,1);
  const other=env();services([],{rejectSend:true});
  await assert.rejects(sendOnce(other,'daily:test','hello'));
  Date.now=()=>realNow()+31000;
  const success=services([]);
  assert.ok(await sendOnce(other,'daily:test','hello'));
  assert.equal(sends(success).length,1);
});
test('empty API never announces cancellation',async()=>{
  const e=env(),calls=services([]);await e.STATE.put('active','1');
  await assert.rejects(monitor(e));assert.equal(sends(calls).length,0);
});
test('Sunday today still processed if next week fails',async()=>{
  Date.now=()=>Date.parse('2026-11-22T14:00:00Z');
  const e=env(),calls=services([row('2026-11-22')]);await e.STATE.put('active','1');
  await assert.rejects(monitor(e));assert.equal(sends(calls).length,1);
  assert.match(sends(calls)[0].data.text,/22.11.2026/);
});
test('change cycles notify each transition, unchanged cron silent',async()=>{
  Date.now=()=>Date.parse('2026-11-17T12:00:00Z');
  const e=env();await e.STATE.put('active','1');
  let total=0;
  for(const subject of ['A','B','A','B','B']) {
    const calls=services([row('2026-11-17',subject)]);await monitor(e);total+=sends(calls).length;
  }
  assert.equal(total,4); // daily plus three changes
});
test('outer router rejects unauthenticated calls before accessing storage',async()=>{
  for(const path of ['/check','/status','/import','/activate','/telegram']) {
    const response=await worker.fetch(new Request('https://bot.example'+path,{method:'POST'}),env());
    assert.equal(response.status,403);
  }
  assert.equal((await worker.fetch(new Request('https://bot.example/cron',{method:'POST'}),env())).status,404);
});
function storage() {
  const values=new Map();return {values,async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async delete(k){for(const x of Array.isArray(k)?k:[k])values.delete(x);},async list({prefix=''}={}){return new Map([...values].filter(([k])=>k.startsWith(prefix)));}};
}
test('Durable Object serializes overlapping deliveries and survives reconstruction',async()=>{
  const e=env(),s=storage(),calls=services([]),ctx={storage:s};
  const bot=new ScheduleBot(ctx,e);
  await s.put('active',{value:'1',expires:0});
  const request=()=>new Request('https://bot.example/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},body:JSON.stringify(command())});
  const responses=await Promise.all([bot.fetch(request()),bot.fetch(request())]);
  assert.ok(responses.every(x=>x.ok));assert.equal(sends(calls).length,1);
  const reconstructed=new ScheduleBot(ctx,e);await reconstructed.fetch(request());
  assert.equal(sends(calls).length,1);
});
test('import preserves published flag without user update offset',async()=>{
  const e=env(),s=storage(),bot=new ScheduleBot({storage:s},e);
  const day=new Date(realNow()+6*3600000).toISOString().slice(0,10);
  const result=await bot.fetch(new Request('https://bot.example/import',{method:'POST',body:JSON.stringify({state:{[day]:{rows:[],published:true},_meta:{offset:123}}})}));
  assert.ok(result.ok);assert.equal(JSON.parse(s.values.get('day:'+day).value).published,true);
  assert.equal([...s.values.keys()].some(x=>x.includes('offset')),false);
});
test('crash after Telegram success leaves durable pending instead of duplicate',async()=>{
  const e=env(),calls=services([]),put=e.STATE.put;
  e.STATE.put=async(k,v)=>{if(JSON.parse(v).status==='sent')throw Error('storage unavailable');return put(k,v);};
  await assert.rejects(sendOnce(e,'daily:crash','hello'));
  e.STATE.put=put;
  assert.equal(await sendOnce(e,'daily:crash','hello'),null);
  assert.equal(sends(calls).length,1);
});
test('failed edit retries without repeating the change notification',async()=>{
  Date.now=()=>Date.parse('2026-11-17T12:00:00Z');
  const e=env();await e.STATE.put('active','1');
  services([row('2026-11-17','A')]);await monitor(e);
  const calls=services([row('2026-11-17','B')]),fetchService=globalThis.fetch;
  globalThis.fetch=async(url,options)=>String(url).endsWith('/editMessageText')?Response.json({ok:false,error_code:403},{status:403}):fetchService(url,options);
  await monitor(e);
  assert.equal(sends(calls).length,1);
  assert.equal((await e.STATE.get('day:2026-11-17',{type:'json'})).editPending,true);
  const retry=services([row('2026-11-17','B')]);await monitor(e);
  assert.equal(sends(retry).length,0);assert.equal(retry.filter(x=>x.method==='editMessageText').length,1);
  assert.equal((await e.STATE.get('day:2026-11-17',{type:'json'})).editPending,false);
});
test('daily recovery edits existing message if source changed after failed state write',async()=>{
  Date.now=()=>Date.parse('2026-11-17T12:00:00Z');
  const e=env();await e.STATE.put('active','1');
  const put=e.STATE.put;
  let failed=false;
  e.STATE.put=async(k,v)=>{if(k==='day:2026-11-17'&&!failed){failed=true;throw Error('storage failed');}return put(k,v);};
  const first=services([row('2026-11-17','A')]);await assert.rejects(monitor(e));
  assert.equal(sends(first).length,1);
  e.STATE.put=put;
  const retry=services([row('2026-11-17','B')]);await monitor(e);
  assert.equal(sends(retry).length,0);
  const edits=retry.filter(x=>x.method==='editMessageText');
  assert.equal(edits.length,1);assert.match(edits[0].data.text,/>2 пара/);
  assert.ok(edits[0].data.text.includes('\nB\n'));
});
