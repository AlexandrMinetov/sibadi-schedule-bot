import os, json, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from pathlib import Path
from collections import Counter

API='https://umu.sibadi.org/api/Rasp'
LINK='https://umu.sibadi.org/webapp/#/Rasp/Group/14992'
STATE=Path('state.json')

def request(url, data=None):
    with urlopen(Request(url, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'SibADI-schedule-bot/1.0'}), timeout=30) as r:
        return json.load(r)

def telegram(method, data=None):
    try:
        result=request('https://api.telegram.org/bot'+os.environ['BOT_TOKEN']+'/'+method,data)
        if not result['ok']: raise RuntimeError('Telegram API error')
        return result['result']
    except Exception:
        raise RuntimeError('Telegram request failed; check secrets and bot permissions') from None

def fetch(day):
    return request(API+'?'+urlencode({'idGroup':14992,'sdate':day.isoformat()}))

def parse(payload, day):
    if isinstance(payload,dict):
        for key in ('rasp','data','schedule'):
            if isinstance(payload.get(key),list): payload=payload[key]; break
    if not isinstance(payload,list) or not payload:
        raise ValueError('Empty or unknown API response; refusing to announce cancellations')
    rows=[]
    for x in payload:
        if not isinstance(x,dict): raise ValueError('Unknown row format')
        start=x.get('датаНачала'); end=x.get('датаОкончания'); subject=x.get('дисциплина')
        if not all(isinstance(v,str) and v for v in (start,end,subject)): raise ValueError('Unknown schedule fields: '+str(list(x)))
        a=datetime.fromisoformat(start.replace('Z','+00:00')); b=datetime.fromisoformat(end.replace('Z','+00:00'))
        if a.tzinfo: a=a.astimezone(ZoneInfo('Asia/Omsk'))
        if b.tzinfo: b=b.astimezone(ZoneInfo('Asia/Omsk'))
        if a.date()==day:
            rows.append(' | '.join([a.strftime('%H:%M')+'–'+b.strftime('%H:%M'),subject]+[str(x[k]) for k in ('видЗанятия','преподаватель','аудитория') if x.get(k)]))
    return sorted(rows)

def send(text):
    if len(text)>4000: raise ValueError('Message too long')
    telegram('sendMessage',{'chat_id':os.environ['CHAT_ID'],'text':text,'link_preview_options':{'is_disabled':True}})

def main():
    now=datetime.now(ZoneInfo('Asia/Omsk')); today=now.date(); tomorrow=today+timedelta(days=1)
    mode=os.getenv('MODE','monitor')
    if mode=='diagnose':
        p=fetch(today); print(json.dumps(p,ensure_ascii=False)[:12000]); return
    if mode=='chat_id':
        for u in telegram('getUpdates',{'allowed_updates':['message']}):
            m=u.get('message',{}); c=m.get('chat',{})
            if c.get('type') in ('group','supergroup') and str(m.get('text','')).startswith('/chatid'):
                print('Group found:',c.get('title')); telegram('sendMessage',{'chat_id':c['id'],'text':'ID беседы: '+str(c['id'])})
        return
    if mode=='test': send('✅ Бот расписания БИ-22Э1 подключён.'); return
    state=json.loads(STATE.read_text()) if STATE.exists() else {}
    new={}
    for d in (today,tomorrow):
        k=d.isoformat(); rows=parse(fetch(d),d); old=state.get(k,{}); published=old.get('published',False)
        title=d.strftime('%d.%m.%Y')
        if d==tomorrow and now.hour>=20 and not published:
            # An empty day is not independently verified by the legacy API.
            send('📅 БИ-22Э1 — '+title+'\n\n'+('\n'.join(rows) if rows else 'В ответе API занятий на эту дату нет. Проверьте официальный сайт.')+'\n\n'+LINK); published=True
        elif 'rows' in old and old['rows']!=rows:
            removed=list((Counter(old['rows'])-Counter(rows)).elements()); added=list((Counter(rows)-Counter(old['rows'])).elements())
            send('⚠️ Изменение расписания — '+title+'\n'+ '\n'.join(['− '+r for r in removed]+['+ '+r for r in added])+'\n\n'+LINK)
        new[k]={'rows':rows,'published':published}
        # Persist after each successful date to minimise repeated notifications.
        state[k]=new[k]; STATE.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
    STATE.write_text(json.dumps(new,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__': main()
