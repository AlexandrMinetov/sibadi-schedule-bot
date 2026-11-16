import json
import os
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Asia/Omsk")
GROUP = 14992
API = "https://umu.sibadi.org/api/Rasp"
LINK = "https://umu.sibadi.org/webapp/#/Rasp/Group/14992"
STATE = Path("state.json")
DAYS = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")


def request(url, data=None):
    req = Request(
        url,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "SibADI-schedule-bot/2.0"},
    )
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def telegram(method, data):
    try:
        result = request("https://api.telegram.org/bot" + os.environ["BOT_TOKEN"] + "/" + method, data)
        if not result.get("ok"):
            raise RuntimeError("Telegram API error")
        return result["result"]
    except Exception:
        raise RuntimeError("Telegram request failed; check secrets and bot permissions") from None


def fetch(day):
    return request(API + "?" + urlencode({"idGroup": GROUP, "sdate": day.isoformat()}))


def local_datetime(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(ZONE) if dt.tzinfo else dt.replace(tzinfo=ZONE)


def parse(payload, day):
    # Verified response structure: data -> rasp, not a top-level array.
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or data.get("isCyclicalSchedule") is not False:
        raise ValueError("Unexpected API envelope or cyclical schedule")
    entries = data.get("rasp")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Empty API response; cannot verify schedule")
    monday = day - timedelta(days=day.weekday())
    sunday = monday + timedelta(days=6)
    covered = False
    rows = []
    for item in entries:
        if not isinstance(item, dict) or item.get("кодГруппы") != GROUP:
            raise ValueError("Unexpected group or invalid schedule row")
        start = local_datetime(item["датаНачала"])
        end = local_datetime(item["датаОкончания"])
        if monday <= start.date() <= sunday:
            covered = True
        if start.date() != day:
            continue
        subject = item["дисциплина"]
        number = item["номерЗанятия"]
        if not isinstance(subject, str) or not subject.strip() or not isinstance(number, int) or end <= start:
            raise ValueError("Invalid lesson")
        teacher = str(item.get("преподаватель") or "не указан").strip()
        room = str(item.get("аудитория") or "не указана").strip()
        prefix = f"{number} пара | {start:%H:%M}–{end:%H:%M}"
        replacement = " (замена)" if item.get("замена") is True else ""
        row = f"{prefix}{replacement}\n{subject.strip()}\n👤 {teacher}\n📍 {room}"
        rows.append((start, number, row))
    if not covered:
        raise ValueError("API returned no entries for the requested week")
    return [row for _, _, row in sorted(rows)]


def send(text):
    if len(text.encode("utf-16-le")) // 2 > 4096:
        raise ValueError("Message too long")
    telegram("sendMessage", {
        "chat_id": int(os.environ["CHAT_ID"]),
        "message_thread_id": int(os.environ["THREAD_ID"]),
        "text": text,
        "link_preview_options": {"is_disabled": True},
    })


def title(day):
    return f"{day:%d.%m.%Y} ({DAYS[day.weekday()]})"


def daily_message(day, rows):
    body = "\n\n".join(rows) if rows else "По данным расписания СибАДИ, занятий на эту дату нет."
    return f"📅 БИ-22Э1 — {title(day)}\n\n{body}\n\n{LINK}"


def changes_message(day, previous, rows):
    removed = sorted((Counter(previous) - Counter(rows)).elements())
    added = sorted((Counter(rows) - Counter(previous)).elements())
    blocks = []
    if removed:
        blocks.append("Было:\n" + "\n\n".join(removed))
    if added:
        blocks.append("Стало:\n" + "\n\n".join(added))
    text = f"⚠️ Изменение расписания — {title(day)}\n\n" + "\n\n".join(blocks) + "\n\n" + LINK
    if len(text.encode("utf-16-le")) // 2 > 4096:
        text = "⚠️ Расписание изменилось.\n\n" + daily_message(day, rows)
    return text


def save(state):
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(STATE)


def main():
    now = datetime.now(ZONE)
    today, tomorrow = now.date(), now.date() + timedelta(days=1)
    mode = os.getenv("MODE", "preview")
    if mode == "test":
        send("✅ Бот расписания БИ-22Э1 подключён.")
        return
    if mode == "diagnose":
        payload = fetch(today)
        print(json.dumps(payload, ensure_ascii=False)[:12000])
        return
    if mode not in ("preview", "monitor", "publish_today"):
        raise ValueError("Unknown mode")
    if mode == "preview":
        for day in (today, tomorrow):
            print(daily_message(day, parse(fetch(day), day)))
        return

    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    state = {key: value for key, value in state.items() if key >= (today - timedelta(days=1)).isoformat()}
    dates = (today,) if mode == "publish_today" else (today, tomorrow)
    errors = []
    for day in dates:
        key = day.isoformat()
        try:
            rows = parse(fetch(day), day)
            previous = state.get(key, {})
            published = previous.get("published", False)
            should_publish = (mode == "publish_today" or (day == tomorrow and now.hour >= 20))
            if should_publish and not published:
                send(daily_message(day, rows))
                published = True
                print("Published", key)
            elif "rows" in previous and previous["rows"] != rows:
                send(changes_message(day, previous["rows"], rows))
                print("Change notification", key)
            else:
                print("No notification", key)
            state[key] = {"rows": rows, "published": published}
            save(state)
        except Exception as exc:
            print(f"Failed {key}: {type(exc).__name__}: {exc}")
            errors.append(key)
    if errors:
        raise RuntimeError("Some schedule dates could not be processed: " + ", ".join(errors))


if __name__ == "__main__":
    main()
