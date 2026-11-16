import json
import os
import re
from html import escape
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


def formatted(text):
    lines = []
    for i, line in enumerate(text.splitlines()):
        safe = escape(line)
        if line == LINK:
            safe = f'<a href="{LINK}">Официальное расписание СибАДИ</a>'
        elif i == 0 or line.startswith("📅 ") or re.match(r"^\d+ пара \|", line) or line in ("Было:", "Стало:"):
            safe = f"<b>{safe}</b>"
        lines.append(safe)
    return "\n".join(lines)


def send(text):
    if len(text.encode("utf-16-le")) // 2 > 4096:
        raise ValueError("Message too long")
    return telegram("sendMessage", {
        "chat_id": int(os.environ["CHAT_ID"]),
        "message_thread_id": int(os.environ["THREAD_ID"]),
        "text": formatted(text),
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    })


def pin_daily(message_id, meta):
    chat_id = int(os.environ["CHAT_ID"])
    previous = meta.get("pinned")
    try:
        telegram("pinChatMessage", {"chat_id": chat_id, "message_id": message_id,
                                    "disable_notification": True})
    except RuntimeError:
        print("Pin skipped: check bot pin permissions")
        return
    meta["pinned"] = message_id
    if previous and previous != message_id:
        try:
            telegram("unpinChatMessage", {"chat_id": chat_id, "message_id": previous})
        except RuntimeError:
            print("Could not unpin previous bot message")


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


COMMANDS = {
    "today": "Расписание на сегодня",
    "tomorrow": "Расписание на завтра",
    "week": "Расписание на текущую неделю",
    "help": "Список команд",
}


def register_commands(meta):
    if meta.get("commands_version") == 1:
        return
    telegram("setMyCommands", {
        "commands": [{"command": command, "description": description}
                     for command, description in COMMANDS.items()],
        "scope": {"type": "chat", "chat_id": int(os.environ["CHAT_ID"])},
    })
    meta["commands_version"] = 1


def read_command(message, chat_id, thread_id, username):
    # Ignore all ordinary messages and every other chat or topic.
    if message.get("chat", {}).get("id") != chat_id or message.get("message_thread_id") != thread_id:
        return None
    if message.get("from", {}).get("is_bot"):
        return None
    entity = next((e for e in message.get("entities", [])
                   if e.get("type") == "bot_command" and e.get("offset") == 0), None)
    if entity is None:
        return None
    # Bot command tokens contain only ASCII characters.
    token = message.get("text", "")[:entity["length"]]
    match = re.fullmatch(r"/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?", token)
    if not match or (match[2] and match[2].lower() != username.lower()):
        return None
    return match[1].lower() if match[1].lower() in COMMANDS else None


def command_messages(command, today, cache):
    def payload(day):
        if day not in cache:
            cache[day] = fetch(day)
        return cache[day]

    if command == "help":
        return ["🤖 Команды бота БИ-22Э1\n\n" +
                "\n".join(f"/{name} — {description}" for name, description in COMMANDS.items()) +
                "\n\nКоманды проверяются примерно каждые 5 минут. Возможны задержки GitHub Actions."]
    if command in ("today", "tomorrow"):
        day = today + timedelta(days=command == "tomorrow")
        return [daily_message(day, parse(payload(day), day))]
    if command == "week":
        monday = today - timedelta(days=today.weekday())
        days = [monday + timedelta(days=i) for i in range(7)]
        data = payload(today)
        header = f"📅 БИ-22Э1 | Неделя {monday:%d.%m}–{days[-1]:%d.%m.%Y}"
        blocks = []
        for day in days:
            rows = parse(data, day)
            blocks.append(f"📅 {title(day)}\n" + ("\n\n".join(rows) if rows else "Занятий нет."))
        # Telegram has a 4096-character limit: keep whole days together.
        messages, current = [], header
        for block in blocks:
            candidate = current + "\n\n" + block
            if len((candidate + "\n\n" + LINK).encode("utf-16-le")) // 2 > 3900:
                messages.append(current + "\n\n" + LINK)
                current = header + " (продолжение)\n\n" + block
            else:
                current = candidate
        messages.append(current + "\n\n" + LINK)
        return messages
    raise ValueError("Unknown command")


def poll_commands(state, today, meta):
    try:
        register_commands(meta)
        save(state)
    except RuntimeError:
        print("Command menu registration failed; polling will continue")
    me = telegram("getMe", {})
    chat_id = int(os.environ["CHAT_ID"])
    thread_id = int(os.environ["THREAD_ID"])
    now = datetime.now(ZONE).timestamp()
    # Telegram can randomize update IDs after a week without updates.
    if now - meta.get("last_update_at", now) > 6 * 86400:
        meta.pop("offset", None)
    updates = telegram("getUpdates", {
        "offset": meta.get("offset", 0), "limit": 100, "timeout": 1,
        "allowed_updates": ["message"],
    })
    cache = {}
    for update in sorted(updates, key=lambda u: u["update_id"]):
        command = read_command(update.get("message", {}), chat_id, thread_id, me["username"])
        if command:
            try:
                messages = command_messages(command, today, cache)
            except Exception:
                messages = ["⚠️ Не удалось получить актуальное расписание. "
                            "Попробуйте позже или откройте официальный сайт.\n\n" + LINK]
            for text in messages:
                send(text)
        # Store only the offset, never chat messages or sender details.
        meta["offset"] = update["update_id"] + 1
        meta["last_update_at"] = int(now)
        save(state)
    print("Command polling complete")


def monitor(state, meta, now, mode):
    today, tomorrow = now.date(), now.date() + timedelta(days=1)
    dates = (today,) if mode == "publish_today" else (today, tomorrow)
    errors = []
    for day in dates:
        key = day.isoformat()
        try:
            rows = parse(fetch(day), day)
            previous = state.get(key, {})
            published = previous.get("published", False)
            message_id = previous.get("message_id")
            should_publish = (mode == "publish_today" or (day == tomorrow and now.hour >= 20))
            if should_publish and not published:
                message_id = send(daily_message(day, rows))["message_id"]
                published = True
                state[key] = {"rows": rows, "published": True, "message_id": message_id}
                save(state)
                pin_daily(message_id, meta)
                print("Published", key)
            elif "rows" in previous and previous["rows"] != rows:
                send(changes_message(day, previous["rows"], rows))
                if published and message_id:
                    try:
                        telegram("editMessageText", {
                            "chat_id": int(os.environ["CHAT_ID"]), "message_id": message_id,
                            "text": formatted(daily_message(day, rows)), "parse_mode": "HTML",
                            "link_preview_options": {"is_disabled": True},
                        })
                    except RuntimeError:
                        print("Could not edit previously published schedule")
                print("Change notification", key)
            else:
                print("No notification", key)
            state[key] = {"rows": rows, "published": published}
            if message_id:
                state[key]["message_id"] = message_id
            save(state)
        except Exception as exc:
            print(f"Failed {key}: {type(exc).__name__}: {exc}")
            errors.append(key)
    if errors:
        raise RuntimeError("Some schedule dates could not be processed: " + ", ".join(errors))


def main():
    now = datetime.now(ZONE)
    today, tomorrow = now.date(), now.date() + timedelta(days=1)
    mode = os.getenv("MODE", "preview")
    if mode == "test":
        send("✅ Бот расписания БИ-22Э1 подключён.")
        return
    if mode == "diagnose":
        payload = fetch(today)
        data = payload.get("data", {})
        print("API fields:", list(data))
        print("Lesson count:", len(data.get("rasp", [])))
        return
    if mode == "preview":
        for day in (today, tomorrow):
            print(daily_message(day, parse(fetch(day), day)))
        return
    if mode not in ("monitor", "poll", "publish_today"):
        raise ValueError("Unknown mode")
    # Refuse legacy monitoring/polling while Cloudflare owns the webhook.
    # Check before sending any schedule, not after monitor() has already run.
    if telegram("getWebhookInfo", {}).get("url"):
        raise RuntimeError("Telegram webhook is active; legacy bot is stopped")
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    state = {key: value for key, value in state.items()
             if key == "_meta" or key >= (today - timedelta(days=1)).isoformat()}
    meta = state.setdefault("_meta", {})
    if mode == "publish_today":
        monitor(state, meta, now, mode)
        return
    errors = []
    if mode == "monitor":
        try:
            monitor(state, meta, now, mode)
        except RuntimeError as exc:
            errors.append(str(exc))
    try:
        poll_commands(state, today, meta)
    except RuntimeError as exc:
        errors.append(str(exc))
    if errors:
        raise RuntimeError("; ".join(errors))


if __name__ == "__main__":
    main()
