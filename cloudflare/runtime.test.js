import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

test('workerd: SQLite, import, activation, concurrent webhook, cron diagnostics',async()=>{
  let sends=0,hook='';
  const secret='x'.repeat(64);
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:fileURLToPath(new URL('./worker.js',import.meta.url)),
    compatibilityDate:'2026-11-01',
    durableObjects:{BOT:{className:'ScheduleBot',useSQLite:true}},
    bindings:{BOT_TOKEN:'test',CHAT_ID:'-100123',THREAD_ID:'42',WEBHOOK_SECRET:secret},
    outboundService:async req=>{
      if(req.url.includes('umu.sibadi.org')) {
        const day=new URL(req.url).searchParams.get('sdate');
        return Response.json({data:{isCyclicalSchedule:false,rasp:[{кодГруппы:14992,датаНачала:day+'T10:00:00',датаОкончания:day+'T11:30:00',дисциплина:'Тест',номерЗанятия:2}]}});
      }
      const method=req.url.split('/').at(-1),body=await req.json();
      let result=true;
      if(method==='getMe') result={username:'SibADI_BI22E1_bot'};
      if(method==='setWebhook') hook=body.url;
      if(method==='getWebhookInfo') result={url:hook,pending_update_count:0};
      if(method==='sendMessage') result={message_id:++sends};
      return Response.json({ok:true,result});
    }
  }));
  try {
    const post=(path,body,telegram=false)=>mf.dispatchFetch('https://bot.example'+path,{
      method:'POST',headers:telegram?{'X-Telegram-Bot-Api-Secret-Token':secret}:{Authorization:'Bearer '+secret},
      body:JSON.stringify(body||{})
    });
    assert.equal((await post('/activate')).status,409);
    assert.equal((await post('/check')).status,200);
    assert.equal((await post('/import',{state:{}})).status,200);
    assert.equal((await post('/activate')).status,200);
    const update={update_id:1,message:{message_id:10,chat:{id:-100123},message_thread_id:42,text:'/help',entities:[{type:'bot_command',offset:0,length:5}]}};
    const replies=await Promise.all([post('/telegram',update,true),post('/telegram',update,true)]);
    assert.ok(replies.every(r=>r.status===200));assert.equal(sends,1);
    const status=await (await post('/status')).json();
    assert.equal(status.active,true);assert.ok(status.lastCommandAt);assert.deepEqual(status.pending,[]);
    const ns=await mf.getDurableObjectNamespace('BOT');
    const cron=await ns.get(ns.idFromName('sibadi-14992')).fetch('https://internal/cron',{method:'POST'});
    assert.ok(cron.ok);
    assert.ok((await (await post('/status')).json()).lastCronSuccessAt);
  } finally {await mf.dispose();}
});
