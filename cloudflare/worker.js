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

async function api(env,method,data={}) {
  // Never log the URL, token, incoming updates or Telegram payload.
  try {
    const r=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/"+method,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data),signal:AbortSignal.timeout(12000)
    });
    const x=await r.json();
    if(!r.ok||!x.ok) throw Error();
    return x.result;
  } catch {throw Error("Telegram "+method+" failed");}
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
    const localISO=value=>{
      if(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value)) {
        if(!Number.isFinite(Date.parse(value+"+06:00"))) throw Error("Invalid date");
        return value;
      }
      if(!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw Error("Invalid date");
      return new Date(Date.parse(value)+6*3600000).toISOString();
    };
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
  for(const text of output) await send(env,text,m.message_id);
  // No user text or identity is stored. TTL limits the deduplication records.
  await env.STATE.put(key,"1",{expirationTtl:86400});
}
async function monitor(env) {
  if(await env.STATE.get("active")!=="1")return;
  const now=omsk(),today=dayOf(now),tomorrow=shift(today,1);
  const data=await fetchWeek(today);
  const next=weekday(today)===6?await fetchWeek(tomorrow):data;
  for(const day of [today,tomorrow]) {
    const rows=(day===today?data:next)[day],key="day:"+day;
    const old=await env.STATE.get(key,{type:"json"})||{};
    let published=!!old.published,id=old.messageId||null;
    if(day===tomorrow&&now.getUTCHours()>=20&&!published) {
      const posted=await send(env,messages([dayBlock(day,rows)])[0]);
      published=true;id=posted.message_id;
      await env.STATE.put(key,JSON.stringify({rows,published,messageId:id}),{expirationTtl:604800});
      const previous=await env.STATE.get("pin",{type:"json"});
      const pinned=await pin(env,id,previous);
      if(pinned) await env.STATE.put("pin",JSON.stringify(pinned));
      continue;
    }
    if(old.rows&&JSON.stringify(old.rows)!==JSON.stringify(rows)) {
      await send(env,"<b>⚠️ Изменение расписания</b>\n\n"+messages([dayBlock(day,rows)])[0]);
      if(published&&id) {
        try {await api(env,"editMessageText",{chat_id:Number(env.CHAT_ID),message_id:id,
          text:messages([dayBlock(day,rows)])[0],parse_mode:"HTML",link_preview_options:{is_disabled:true}});}
        catch {console.warn("Could not edit previously published schedule");}
      }
    } else if(old.rows) continue;
    await env.STATE.put(key,JSON.stringify({rows,published,messageId:id}),{expirationTtl:604800});
  }
}
export default {
  async fetch(req,env) {
    const url=new URL(req.url);
    if(req.method==="GET"&&url.pathname==="/")return new Response("SibADI schedule worker");
    if(req.method!=="POST")return new Response("Not found",{status:404});
    if(url.pathname==="/telegram") {
      if(!env.WEBHOOK_SECRET||req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET)return new Response("Forbidden",{status:403});
      try {
        const u=await req.json();
        if(!Number.isSafeInteger(u.update_id))return new Response("Invalid update",{status:400});
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
        const me=await api(env,"getMe");
        return json({ok:true,bot:me.username,today,todayLessons:data[today].length,tomorrowLessons:next[tomorrow].length,active:await env.STATE.get("active")==="1"});
      }
      if(url.pathname==="/activate") {
        await api(env,"setMyCommands",{commands:COMMANDS,scope:{type:"chat",chat_id:Number(env.CHAT_ID)}});
        await api(env,"setWebhook",{url:url.origin+"/telegram",secret_token:env.WEBHOOK_SECRET,
          allowed_updates:["message"],max_connections:1,drop_pending_updates:false});
        await env.STATE.put("active","1");
        return json({ok:true,webhook:true,monitoring:true});
      }
      await env.STATE.put("active","0");
      await api(env,"deleteWebhook",{drop_pending_updates:false});
      return json({ok:true,webhook:false,monitoring:false});
    } catch(e) {return json({ok:false,error:e instanceof Error?e.message:"Unknown error"},502);}
  },
  async scheduled(event,env,ctx) {ctx.waitUntil(monitor(env));}
};
