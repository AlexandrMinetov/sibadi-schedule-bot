const GROUP = 14992;
const LINK = "https://umu.sibadi.org/webapp/#/Rasp/Group/14992";
const API = "https://umu.sibadi.org/api/Rasp";
const COMMANDS = [
  {command:"today",description:"Расписание на сегодня"},
  {command:"tomorrow",description:"Расписание на завтра"},
  {command:"week",description:"Расписание на текущую неделю"},
  {command:"help",description:"Список команд"}
];
const DAYS = ["понедельник","вторник","среда","четверг","пятница","суббота","воскресенье"];
const omsk = () => new Date(Date.now()+6*3600000);
const dayOf = d => d.toISOString().slice(0,10);
const shift = (day,n) => dayOf(new Date(Date.parse(day+"T00:00:00Z")+n*86400000));
const weekday = day => (new Date(day+"T00:00:00Z").getUTCDay()+6)%7;
const title = day => day.split("-").reverse().join(".")+" ("+DAYS[weekday(day)]+")";
const esc = x => String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const source = '<a href="'+LINK+'">Официальное расписание СибАДИ</a>';
const json = (data,status=200) => Response.json(data,{status,headers:{"Cache-Control":"no-store"}});

class TelegramError extends Error {
  constructor(method, code, retryAfter) {
    super("Telegram " + method + " failed" + (code ? " (" + code + ")" : ""));
    this.definite = Number.isInteger(code) && code >= 400 && code < 500;
    this.retryAfter = retryAfter || 0;
  }
}
async function api(env,method,data={}) {
  // Never log the URL, token, incoming updates or Telegram payload.
  try {
    const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data),signal:AbortSignal.timeout(12000)
    });
    const x=await r.json();
    // A previous edit may have succeeded before its response was lost.
    if(method==="editMessageText"&&x.error_code===400&&/message is not modified/i.test(x.description||"")) return true;
    if(!r.ok||!x.ok) throw new TelegramError(method,x.error_code,x.parameters?.retry_after);
    return x.result;
  } catch(e) {throw e instanceof TelegramError ? e : new TelegramError(method);}
}
function localISO(value) {
  const match=/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  if(!match || +match[2]>23 || +match[3]>59 || +(match[4]||0)>59) throw Error("Invalid date");
  const date=new Date(match[1]+"T00:00:00Z");
  if(!Number.isFinite(+date) || dayOf(date)!==match[1]) throw Error("Invalid date");
  if(!match[5]) return value;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)) throw Error("Invalid date");
  return new Date(parsed+6*3600000).toISOString();
}
async function fetchWeek(day) {
  const u=new URL(API);
  u.searchParams.set("idGroup",String(GROUP));
  u.searchParams.set("sdate",day);
  const r=await fetch(u,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw Error("Schedule API HTTP "+r.status);
  const d=(await r.json()).data;
  if(d?.isCyclicalSchedule!==false || !Array.isArray(d.rasp)||!d.rasp.length)
    throw Error("Unverified schedule response");
  const start=shift(day,-weekday(day)),end=shift(start,6);
  const days={};
  for(let i=0;i<7;i++) days[shift(start,i)]=[];
  let covered=false;
  for(const x of d.rasp) {
    if(x?.кодГруппы!==GROUP || typeof x.датаНачала!=="string" || typeof x.датаОкончания!=="string")
      throw Error("Invalid schedule row");
    // The verified SibADI response uses local, offset-free ISO strings.
    const a=localISO(x.датаНачала), b=localISO(x.датаОкончания), date=a.slice(0,10);
    if(date<start||date>end) continue;
    covered=true;
    if(typeof x.дисциплина!=="string"||!x.дисциплина.trim()||!Number.isInteger(x.номерЗанятия)||b.slice(0,16)<=a.slice(0,16))
      throw Error("Invalid lesson");
    const row=[
      x.номерЗанятия+" пара | "+a.slice(11,16)+"–"+b.slice(11,16)+(x.замена===true?" (замена)":""),
      x.дисциплина.trim(),
      "👤 "+String(x.преподаватель||"не указан").trim(),
      "📍 "+String(x.аудитория||"не указана").trim()
    ].join("\n");
    days[date].push({time:a,row});
  }
  if(!covered) throw Error("Requested week absent from API");
  for(const k of Object.keys(days)) days[k]=days[k].sort((a,b)=>a.time.localeCompare(b.time)||a.row.localeCompare(b.row)).map(x=>x.row);
  return days;
}
function dayBlock(day,rows) {
  return "<b>📅 БИ-22Э1 — "+esc(title(day))+"</b>\n\n"+
    (rows.length?rows.map(row=>{const [head,...rest]=row.split("\n");return "<b>"+esc(head)+"</b>\n"+rest.map(esc).join("\n");}).join("\n\n"):"По данным расписания СибАДИ, занятий нет.");
}
function messages(blocks) {
  let output=[],current="";
  for(const b of blocks) {
    if(b.length+source.length>3950) throw Error("Schedule block too long");
    if(current && (current+"\n\n"+b+"\n\n"+source).length>3950) {
      output.push(current+"\n\n"+source);current="";
    }
    current+=(current?"\n\n":"")+b;
  }
  if(current) output.push(current+"\n\n"+source);
  return output;
}
async function send(env,text,reply) {
  const data={chat_id:Number(env.CHAT_ID),message_thread_id:Number(env.THREAD_ID),text,
    parse_mode:"HTML",link_preview_options:{is_disabled:true}};
  if(reply) data.reply_parameters={message_id:reply,allow_sending_without_reply:true};
  return api(env,"sendMessage",data);
}
async function pin(env,id,old) {
  try {
    await api(env,"pinChatMessage",{chat_id:Number(env.CHAT_ID),message_id:id,disable_notification:true});
    if(old&&old!==id) {
      try {await api(env,"unpinChatMessage",{chat_id:Number(env.CHAT_ID),message_id:old});}
      catch {console.warn("Old pin could not be removed");}
    }
    return id;
  } catch {console.warn("Pin skipped: check bot permissions");return old;}
}
const help="<b>🤖 Команды бота БИ-22Э1</b>\n\n"+COMMANDS.map(x=>"/"+x.command+" — "+x.description).join("\n");
async function handleCommand(env,u) {
  const m=u.message;
  if(!m||m.chat?.id!==Number(env.CHAT_ID)||m.message_thread_id!==Number(env.THREAD_ID)||m.from?.is_bot) return;
  const entity=m.entities?.find(e=>e.type==="bot_command"&&e.offset===0);
  if(!entity||typeof m.text!=="string") return;
  const match=/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?$/.exec(m.text.slice(0,entity.length));
  if(!match||(match[2]&&match[2].toLowerCase()!==(env.BOT_USERNAME||"sibadi_bi22e1_bot").toLowerCase()))return;
  const cmd=match[1].toLowerCase();
  if(!COMMANDS.some(x=>x.command===cmd)) return;
  const key="update:"+u.update_id;
  if(await env.STATE.get(key)) return;
  let output;
  try {
    const today=dayOf(omsk());
    if(cmd==="help") output=[help];
    else if(cmd==="week") {
      const data=await fetchWeek(today), start=shift(today,-weekday(today));
      output=messages(Array.from({length:7},(_,i)=>{const d=shift(start,i);return dayBlock(d,data[d]);}));
    } else {
      const day=shift(today,cmd==="tomorrow"?1:0),data=await fetchWeek(day);
      output=messages([dayBlock(day,data[day])]);
    }
  } catch {output=["⚠️ Не удалось получить актуальное расписание.\n\n"+source];}
  for(let i=0;i<output.length;i++) await sendOnce(env,"command:"+u.update_id+":"+i,output[i],m.message_id);
  // No user text or identity is stored. TTL limits the deduplication records.
  await env.STATE.put(key,"1",{expirationTtl:86400});
  await env.STATE.put("lastCommandAt",new Date().toISOString());
}
async function monitor(env) {
  if(await env.STATE.get("active")!=="1")return;
  const now=omsk(),today=dayOf(now),tomorrow=shift(today,1);
  const cache=new Map(),errors=[];
  for(const day of [today,tomorrow]) {
    try {
    const monday=shift(day,-weekday(day));
    if(!cache.has(monday)) cache.set(monday,await fetchWeek(day));
    const rows=cache.get(monday)[day],key="day:"+day;
    const old=await env.STATE.get(key,{type:"json"})||{};
    let published=!!old.published,id=old.messageId||null;
    // Catch up a missed evening publication after midnight, once, for today.
    if((day===today||now.getUTCHours()>=20)&&!published) {
      const text=messages([dayBlock(day,rows)])[0];
      const posted=await sendOnce(env,"daily:"+day,text);
      if(!posted) continue;
      published=true;id=posted.message_id;
      await env.STATE.put(key,JSON.stringify({rows,published,messageId:id,editPending:!!posted.recovered}),{expirationTtl:604800});
      const previous=await env.STATE.get("pin",{type:"json"});
      const pinned=await pin(env,id,previous);
      if(pinned) await env.STATE.put("pin",JSON.stringify(pinned));
      if(!posted.recovered) continue;
      // The source may have changed between a successful send and recovery
      // from a failed state write. Bring that same message up to date.
      old.rows=rows;
      old.editPending=true;
    }
    if(old.rows&&JSON.stringify(old.rows)!==JSON.stringify(rows)) {
      const text="<b>⚠️ Изменение расписания</b>\n\n"+messages([dayBlock(day,rows)])[0];
      // Include the old version: an A -> B -> A change must notify twice.
      const hash=await digest(JSON.stringify([old.revision||0,old.rows,rows]));
      const posted=await sendOnce(env,"change:"+day+":"+hash,text);
      if(!posted) continue;
      old.editPending=published&&!!id;
    } else if(old.rows&&!old.editPending) continue;
    const current={rows,published,messageId:id,revision:(old.revision||0)+(JSON.stringify(old.rows)!==JSON.stringify(rows)?1:0),editPending:!!old.editPending};
    // Save notification progress before editing: edit failure must not repeat it.
    await env.STATE.put(key,JSON.stringify(current),{expirationTtl:604800});
    if(current.editPending) {
      try {
        await api(env,"editMessageText",{chat_id:Number(env.CHAT_ID),message_id:id,
          text:messages([dayBlock(day,rows)])[0],parse_mode:"HTML",link_preview_options:{is_disabled:true}});
        current.editPending=false;
        await env.STATE.put(key,JSON.stringify(current),{expirationTtl:604800});
      } catch {console.warn("Could not edit previously published schedule; will retry");}
    }
    } catch {errors.push(day);}
  }
  if(errors.length) throw Error("Schedule monitoring incomplete: "+errors.join(", "));
}
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),
    x=>x.toString(16).padStart(2,"0")).join("");
}

// Telegram sendMessage has no idempotency key. Persist intent BEFORE sending.
// An ambiguous timeout/crash is left pending for operator reconciliation, never
// automatically resent. Definite 4xx rejections can be safely retried later.
async function sendOnce(env,key,text,reply) {
  const opKey="op:"+key,existing=await env.STATE.get(opKey,{type:"json"});
  if(existing?.status==="sent") return {message_id:existing.messageId,recovered:true};
  if(existing?.status==="pending") return null;
  if(existing?.retryAt>Date.now()) throw Error("Telegram retry deferred");
  await env.STATE.put(opKey,JSON.stringify({status:"pending",at:Date.now()}));
  try {
    const result=await send(env,text,reply);
    if(!Number.isSafeInteger(result?.message_id)) throw Error("Invalid Telegram result");
    await env.STATE.put(opKey,JSON.stringify({status:"sent",messageId:result.message_id,at:Date.now()}),{expirationTtl:8*86400});
    return result;
  } catch(e) {
    if(e.definite) await env.STATE.put(opKey,JSON.stringify({status:"rejected",at:Date.now(),retryAt:Date.now()+Math.max(e.retryAfter,15)*1000}),{expirationTtl:8*86400});
    throw e;
  }
}

function validate(env) {
  if(!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET||"") ||
     !/^-\d+$/.test(env.CHAT_ID||"") || !Number.isSafeInteger(Number(env.CHAT_ID)) ||
     !/^\d+$/.test(env.THREAD_ID||"") || !Number.isSafeInteger(Number(env.THREAD_ID)) || Number(env.THREAD_ID)<1)
    throw Error("Check BOT_TOKEN, CHAT_ID, THREAD_ID and WEBHOOK_SECRET bindings");
}

// SQLite-backed Durable Object, one singleton for this existing bot.
// The promise chain serializes across external fetch awaits as well as storage.
export class ScheduleBot {
  constructor(ctx,env) {this.ctx=ctx;this.env=env;this.tail=Promise.resolve();}
  fetch(req) {
    const task=this.tail.then(()=>this.run(req));
    this.tail=task.catch(()=>{});
    return task;
  }
  async run(req) {
    const storage=this.ctx.storage;
    const state={
      get:async(key,options)=>{
        const record=await storage.get(key);
        if(!record || (record.expires&&record.expires<=Date.now())) return null;
        return options?.type==="json"?JSON.parse(record.value):record.value;
      },
      put:async(key,value,options)=>storage.put(key,{value,expires:options?.expirationTtl?Date.now()+options.expirationTtl*1000:0})
    };
    const env={...this.env,STATE:state};
    try {
      validate(env);
      const path=new URL(req.url).pathname;
      if(path==="/cron") {
        await state.put("lastCronAt",new Date().toISOString());
        await monitor(env);
        await state.put("lastCronSuccessAt",new Date().toISOString());
        // Delete expired technical records daily; never store user messages.
        const today=dayOf(omsk());
        if(await state.get("cleaned")!==today) {
          const records=await storage.list();
          const expired=[...records].filter(([,v])=>v.expires&&v.expires<=Date.now()).map(([k])=>k);
          for(let i=0;i<expired.length;i+=128) await storage.delete(expired.slice(i,i+128));
          await state.put("cleaned",today);
        }
        return json({ok:true});
      }
      if(path==="/status") {
        const records=await storage.list({prefix:"op:"});
        const pending=[...records].filter(([,v])=>JSON.parse(v.value).status==="pending").map(([k])=>k.slice(3));
        return json({ok:true,version:2,active:await state.get("active")==="1",imported:!!await state.get("imported"),
          lastCronAt:await state.get("lastCronAt"),lastCronSuccessAt:await state.get("lastCronSuccessAt"),
          lastCommandAt:await state.get("lastCommandAt"),pending});
      }
      if(path==="/import") {
        if(await state.get("active")==="1") return json({ok:false,error:"Deactivate before import"},409);
        if(await state.get("imported")) return json({ok:true,alreadyImported:true});
        const body=await req.json();
        const legacy=this.env.LEGACY_STATE;
        // Only schedule snapshots and IDs of the bot's own messages are imported.
        const seed=body.state;
        if(!seed || typeof seed!=="object" || Array.isArray(seed)) return json({ok:false,error:"state object required"},400);
        const today=dayOf(omsk());
        for(let i=-1;i<=7;i++) {
          const day=shift(today,i),key="day:"+day;
          const old=legacy?await legacy.get(key,{type:"json"}):null;
          const item=old||seed[day];
          if(!item) continue;
          if(!Array.isArray(item.rows)||!item.rows.every(x=>typeof x==="string")||typeof item.published!=="boolean")
            return json({ok:false,error:"Invalid schedule state"},400);
          const messageId=item.messageId||item.message_id||null;
          if(messageId!==null&&(!Number.isSafeInteger(messageId)||messageId<1)) return json({ok:false,error:"Invalid bot message ID"},400);
          await state.put(key,JSON.stringify({rows:item.rows,published:item.published,messageId}),{expirationTtl:8*86400});
        }
        const previous=legacy?await legacy.get("pin",{type:"json"}):null;
        const pinned=previous||seed._meta?.pinned;
        if(Number.isSafeInteger(pinned)&&pinned>0) await state.put("pin",JSON.stringify(pinned));
        await state.put("imported","1");
        return json({ok:true,imported:true});
      }
      if(path==="/resolve") {
        const body=await req.json(),key="op:"+body.operation;
        const op=await state.get(key,{type:"json"});
        if(op?.status!=="pending") return json({ok:false,error:"Pending operation not found"},404);
        if(body.action==="retry") await storage.delete(key);
        else if(body.action==="delivered"&&Number.isSafeInteger(body.messageId)&&body.messageId>0)
          await state.put(key,JSON.stringify({status:"sent",messageId:body.messageId,at:Date.now()}),{expirationTtl:8*86400});
        else return json({ok:false,error:"Use retry or delivered with messageId"},400);
        return json({ok:true});
      }
      return await routes.fetch(req,env);
    } catch {return json({ok:false,error:"Operation failed; check bindings and service availability"},502);}
  }
}

const routes = {
  async fetch(req,env) {
    const url=new URL(req.url);
    if(req.method==="GET"&&url.pathname==="/")return new Response("SibADI schedule worker");
    if(req.method!=="POST")return new Response("Not found",{status:404});
    if(url.pathname==="/telegram") {
      if(!env.WEBHOOK_SECRET||req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET)return new Response("Forbidden",{status:403});
      try {
        const u=await req.json();
        if(!Number.isSafeInteger(u.update_id))return new Response("Invalid update",{status:400});
        if(await env.STATE.get("active")!=="1") return new Response("Inactive",{status:503});
        await handleCommand(env,u);
        return new Response("OK");
      } catch {return new Response("Retry",{status:503});}
    }
    if(!["/check","/activate","/deactivate"].includes(url.pathname))return new Response("Not found",{status:404});
    if(!env.WEBHOOK_SECRET||req.headers.get("Authorization")!=="Bearer "+env.WEBHOOK_SECRET)return new Response("Forbidden",{status:403});
    try {
      if(url.pathname==="/check") {
        const today=dayOf(omsk()),tomorrow=shift(today,1);
        const data=await fetchWeek(today),next=weekday(today)===6?await fetchWeek(tomorrow):data;
        const me=await api(env,"getMe"),hook=await api(env,"getWebhookInfo");
        if(me.username?.toLowerCase()!==(env.BOT_USERNAME||"sibadi_bi22e1_bot").toLowerCase()) throw Error("Unexpected bot identity");
        await env.STATE.put("checkedAt",String(Date.now()));
        return json({ok:true,version:2,bot:me.username,today,todayLessons:data[today].length,tomorrowLessons:next[tomorrow].length,
          webhookMatches:hook.url===url.origin+"/telegram",pendingUpdates:hook.pending_update_count,
          webhookErrorAt:hook.last_error_date||null,active:await env.STATE.get("active")==="1"});
      }
      if(url.pathname==="/activate") {
        if(Date.now()-Number(await env.STATE.get("checkedAt")||0)>15*60000) return json({ok:false,error:"Run /check first"},409);
        if(!await env.STATE.get("imported")) return json({ok:false,error:"Import existing schedule state first"},409);
        await api(env,"setMyCommands",{commands:COMMANDS,scope:{type:"chat",chat_id:Number(env.CHAT_ID)}});
        await api(env,"setWebhook",{url:url.origin+"/telegram",secret_token:env.WEBHOOK_SECRET,
          allowed_updates:["message"],max_connections:1,drop_pending_updates:false});
        const hook=await api(env,"getWebhookInfo");
        if(hook.url!==url.origin+"/telegram") throw Error("Webhook verification failed");
        await env.STATE.put("active","1");
        return json({ok:true,webhook:true,monitoring:true});
      }
      await env.STATE.put("active","0");
      await api(env,"deleteWebhook",{drop_pending_updates:false});
      return json({ok:true,webhook:false,monitoring:false});
    } catch(e) {return json({ok:false,error:e instanceof Error?e.message:"Unknown error"},502);}
  }
};

export default {
  async fetch(req,env) {
    const path=new URL(req.url).pathname;
    if(req.method==="GET"&&path==="/")return json({service:"SibADI schedule worker",version:2});
    if(req.method!=="POST"||!["/telegram","/check","/status","/import","/resolve","/activate","/deactivate"].includes(path))return new Response("Not found",{status:404});
    const header=path==="/telegram"?"X-Telegram-Bot-Api-Secret-Token":"Authorization";
    const expected=path==="/telegram"?env.WEBHOOK_SECRET:"Bearer "+env.WEBHOOK_SECRET;
    if(!env.WEBHOOK_SECRET||req.headers.get(header)!==expected)return new Response("Forbidden",{status:403});
    if(!env.BOT) return json({ok:false,error:"BOT Durable Object binding missing"},503);
    return env.BOT.get(env.BOT.idFromName("sibadi-14992")).fetch(req);
  },
  async scheduled(event,env,ctx) {
    const task=(async()=>{
      const result=await env.BOT.get(env.BOT.idFromName("sibadi-14992")).fetch(new Request("https://internal/cron",{method:"POST"}));
      if(!result.ok) throw Error("Scheduled monitoring failed");
    })();
    ctx.waitUntil(task);
  }
};

export {fetchWeek,localISO,messages,dayBlock,monitor,handleCommand,sendOnce};
