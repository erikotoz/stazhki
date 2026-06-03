#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сервер «Стажки в расчёте» — версия с ГРУППАМИ.

Модель:
  • user      — глобальная личность (Telegram-аккаунт; локально — dev-логин).
  • group     — компания друзей со своим набором трат.
  • member    — «место» в группе. Может быть «призраком» (user_id=NULL) — за него
                уже можно заносить траты. Когда реальный человек заходит, он
                ЗАНИМАЕТ место (по совпадению @username) со всеми накопленными долгами.
  • expense / payment — привязаны к группе и ссылаются на member (не на user).

Хранилище:
  • локально:  python3 server.py            → SQLite (cash.db), dev-логин включён.
  • в облаке:  задан DATABASE_URL           → Postgres; задан BOT_TOKEN → вход только через Telegram.
"""

import os, json, re, time, hmac, hashlib, secrets, sqlite3, threading
from urllib.parse import urlparse, parse_qs, parse_qsl
import urllib.request
import http.server, socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "cash.db")
WEB_DIR = os.path.join(HERE, "web")
PORT = int(os.environ.get("PORT", "8000"))

DATABASE_URL = os.environ.get("DATABASE_URL")
USE_PG = bool(DATABASE_URL)
BOT_TOKEN = os.environ.get("BOT_TOKEN")           # есть → продакшн-вход через Telegram
DEV_LOGIN = not BOT_TOKEN                          # нет токена → разрешаем dev-логин (локально)
BOT_USERNAME = os.environ.get("BOT_USERNAME", "stazhki_v_raschete_bot")
BOT_APP = os.environ.get("BOT_APP", "app")        # short name мини-аппы в BotFather (для ссылок startapp)
APP_URL = (os.environ.get("APP_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").rstrip("/")
if USE_PG:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool
    # Пул соединений: открываем один раз и переиспользуем — без этого каждый
    # запрос тратил бы ~секунды на установку соединения с Supabase.
    PG_POOL = ConnectionPool(
        DATABASE_URL, min_size=1, max_size=8, timeout=15,
        max_idle=300, max_lifetime=1800,
        check=ConnectionPool.check_connection,
        kwargs={"row_factory": dict_row, "autocommit": True, "prepare_threshold": None},
        open=False,
    )
    PG_POOL.open()

HUES = [262, 214, 304, 188, 338, 28, 152, 48, 95, 240, 12, 200, 330, 70]
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".jsx": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


# ─────────────────────────── СЛОЙ БАЗЫ ───────────────────────────
def q(sql):
    return sql.replace("?", "%s") if USE_PG else sql


def get_conn():
    if USE_PG:
        return PG_POOL.getconn()
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def release(conn):
    if USE_PG:
        PG_POOL.putconn(conn)
    else:
        conn.close()


def ex(conn, sql, params=()):
    return conn.execute(q(sql), params)


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, tg_id TEXT, username TEXT, name TEXT NOT NULL, color TEXT,
        pay_phone TEXT, pay_bank TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS groups(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL,
        created_by TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS members(
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, display_name TEXT NOT NULL,
        claim_username TEXT, user_id TEXT, color TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS expenses(
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer TEXT NOT NULL, amount REAL NOT NULL,
        title TEXT, category TEXT, date TEXT, split TEXT, author_member TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS payments(
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, from_member TEXT NOT NULL, to_member TEXT NOT NULL,
        amount REAL NOT NULL, status TEXT NOT NULL, note TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS notifications(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, group_id TEXT, type TEXT NOT NULL, text TEXT NOT NULL,
        data TEXT, read INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL)""",
]


LEGACY_TABLES = ["sessions", "expenses", "payments", "notifications", "members", "groups", "users"]


def table_columns(conn, table):
    if USE_PG:
        rows = ex(conn, "SELECT column_name FROM information_schema.columns "
                  "WHERE table_name=? AND table_schema='public'", (table,)).fetchall()
        return {r["column_name"] for r in rows}
    rows = ex(conn, "PRAGMA table_info(%s)" % table).fetchall()
    return {r["name"] for r in rows}


def migrate(conn):
    # Если осталась старая несовместимая схема (users без tg_id) — удаляем старые таблицы,
    # чтобы пересоздать под текущую модель. Данные были временными/тестовыми.
    try:
        cols = table_columns(conn, "users")
        if cols and "tg_id" not in cols:
            for t in LEGACY_TABLES:
                ex(conn, ("DROP TABLE IF EXISTS %s CASCADE" if USE_PG else "DROP TABLE IF EXISTS %s") % t)
            print("  migrate: обнаружена старая схема — таблицы пересозданы под группы")
    except Exception as e:
        print("  migrate: пропуск (%s)" % e)


def init_db():
    conn = get_conn()
    try:
        migrate(conn)
        for s in SCHEMA:
            ex(conn, s)
    finally:
        release(conn)


def uid(p):  # короткий id с префиксом
    return p + secrets.token_hex(5)


def norm_username(u):
    return (u or "").lstrip("@").strip().lower() or None


# ─────────────────────────── СЕРИАЛИЗАЦИЯ ───────────────────────────
def member_public(r, me_id):
    claimed = bool(r["user_id"])
    out = {"id": r["id"], "name": r["display_name"], "color": r["color"],
           "claimed": claimed, "isMe": claimed and r["user_id"] == me_id,
           "username": r["claim_username"]}
    return out


def expense_public(r):
    try:
        split = json.loads(r["split"]) if r["split"] else {}
    except Exception:
        split = {}
    return {"id": r["id"], "groupId": r["group_id"], "payer": r["payer"], "amount": r["amount"],
            "title": r["title"], "category": r["category"], "date": r["date"], "split": split,
            "author": r["author_member"]}


def payment_public(r):
    return {"id": r["id"], "groupId": r["group_id"], "from": r["from_member"], "to": r["to_member"],
            "amount": r["amount"], "status": r["status"], "note": r["note"], "created": r["created"]}


def notification_public(r):
    try:
        data = json.loads(r["data"]) if r["data"] else {}
    except Exception:
        data = {}
    return {"id": r["id"], "type": r["type"], "text": r["text"], "data": data,
            "read": bool(r["read"]), "groupId": r["group_id"], "created": r["created"]}


def user_public(r):
    return {"id": r["id"], "name": r["name"], "username": r["username"], "color": r["color"],
            "payPhone": r["pay_phone"], "payBank": r["pay_bank"]}


def fmt_rub(a):
    return "{:,}".format(int(round(a))).replace(",", " ") + " ₽"


def notify(conn, user_id, gid, ntype, text, data):
    if not user_id:
        return
    ex(conn, "INSERT INTO notifications(id,user_id,group_id,type,text,data,read,created) VALUES(?,?,?,?,?,?,0,?)",
       (uid("n"), user_id, gid, ntype, text, json.dumps(data, ensure_ascii=False), time.time()))


def members_of(conn, gid, me_id):
    return [member_public(r, me_id) for r in
            ex(conn, "SELECT * FROM members WHERE group_id=? ORDER BY created", (gid,)).fetchall()]


def my_member(conn, gid, me_id):
    return ex(conn, "SELECT * FROM members WHERE group_id=? AND user_id=?", (gid, me_id)).fetchone()


def expense_involves_member(e, mid):
    if not mid:
        return False
    if e["payer"] == mid:
        return True
    sp = e.get("split") or {}
    mode = sp.get("mode")
    if mode == "shares":
        return (sp.get("shares") or {}).get(mid, 0) > 0
    if mode == "exact":
        return mid in (sp.get("exact") or {})
    return mid in (sp.get("among") or [])   # equal (по умолчанию)


def _owed_for_expense(e):
    """Доли по трате -> {member_id: копейки}."""
    out = {}
    total = round((e.get("amount") or 0) * 100)
    sp = e.get("split") or {}
    mode = sp.get("mode", "equal")
    if mode == "shares":
        sh = {k: v for k, v in (sp.get("shares") or {}).items() if v and v > 0}
        s = sum(sh.values()) or 1
        items = list(sh.items()); assigned = 0
        for i, (k, v) in enumerate(items):
            c = (total - assigned) if i == len(items) - 1 else round(total * v / s)
            out[k] = c; assigned += c
    elif mode == "exact":
        for k, v in (sp.get("exact") or {}).items():
            out[k] = round((v or 0) * 100)
    else:
        among = sp.get("among") or []
        if among:
            base = total // len(among); rem = total - base * len(among)
            for i, k in enumerate(among):
                out[k] = base + (1 if i < rem else 0)
    return out


def fmt_k(kop):
    """Копейки -> «1 200 ₽»."""
    neg = kop < 0; kop = abs(int(round(kop)))
    rub = kop // 100; k = kop % 100
    s = "{:,}".format(rub).replace(",", " ")
    if k:
        s += ",%02d" % k
    return ("−" if neg else "") + s + " ₽"


def personal_totals(conn, gid, mid):
    """(вам должны, вы должны) для участника mid в копейках — нетто по парам."""
    if not mid:
        return (0, 0)
    exps = [expense_public(r) for r in ex(conn, "SELECT * FROM expenses WHERE group_id=?", (gid,)).fetchall()]
    pays = [payment_public(r) for r in ex(conn, "SELECT * FROM payments WHERE group_id=? AND status!='disputed'", (gid,)).fetchall()]
    per = {}
    for e in exps:
        owed = _owed_for_expense(e)
        if e["payer"] == mid:
            for pid, k in owed.items():
                if pid != mid and k > 0:
                    per[pid] = per.get(pid, 0) + k
        elif owed.get(mid, 0) > 0:
            per[e["payer"]] = per.get(e["payer"], 0) - owed[mid]
    for p in pays:
        k = round(p["amount"] * 100)
        if p["from"] == mid:
            per[p["to"]] = per.get(p["to"], 0) + k
        elif p["to"] == mid:
            per[p["from"]] = per.get(p["from"], 0) - k
    return (sum(v for v in per.values() if v > 0), sum(-v for v in per.values() if v < 0))


def member_chat_id(conn, member_id):
    r = ex(conn, "SELECT u.tg_id AS tg FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=?", (member_id,)).fetchone()
    return r["tg"] if r and r["tg"] else None


def tg_send(chat_id, text):
    """Отправка сообщения пользователю ботом (в фоне, не тормозит ответ)."""
    if not BOT_TOKEN or not chat_id:
        return
    threading.Thread(target=lambda: tg_api("sendMessage",
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}), daemon=True).start()


def unique_name(conn, gid, name, exclude=None):
    """Уникальное отображаемое имя в группе (добавляет (2), (3)… при совпадении)."""
    name = (name or "").strip() or "Участник"
    taken = {r["display_name"] for r in
             ex(conn, "SELECT id, display_name FROM members WHERE group_id=?", (gid,)).fetchall()
             if r["id"] != exclude}
    if name not in taken:
        return name
    i = 2
    while ("%s (%d)" % (name, i)) in taken:
        i += 1
    return "%s (%d)" % (name, i)


def group_state(conn, gid, me_id):
    g = ex(conn, "SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
    if not g:
        return None
    members = members_of(conn, gid, me_id)
    mine = my_member(conn, gid, me_id)
    my_mid = mine["id"] if mine else None
    expenses = [expense_public(r) for r in ex(conn, "SELECT * FROM expenses WHERE group_id=? ORDER BY date,created", (gid,)).fetchall()]
    payments = [payment_public(r) for r in ex(conn, "SELECT * FROM payments WHERE group_id=? ORDER BY created", (gid,)).fetchall()]
    # Приватность: «за что» (название/категория/заметка) видит только участник траты/перевода.
    # Суммы и «кто кому» остаются — чтобы корректно считались балансы и граф.
    for e in expenses:
        if not expense_involves_member(e, my_mid):
            e["title"] = ""
            e["category"] = "other"
            e["hidden"] = True
    for p in payments:
        if my_mid not in (p["from"], p["to"]):
            p["note"] = ""
            p["hidden"] = True
    notifs = [notification_public(r) for r in ex(conn,
              "SELECT * FROM notifications WHERE user_id=? AND (group_id=? OR group_id IS NULL) ORDER BY created DESC LIMIT 50",
              (me_id, gid)).fetchall()]
    # реквизиты участников (для занятых мест)
    pay_rows = ex(conn, "SELECT m.id mid, u.pay_phone pp, u.pay_bank pb FROM members m "
                  "JOIN users u ON u.id=m.user_id WHERE m.group_id=?", (gid,)).fetchall()
    payinfo = {r["mid"]: {"payPhone": r["pp"], "payBank": r["pb"]} for r in pay_rows}
    return {"group": {"id": g["id"], "name": g["name"], "inviteCode": g["invite_code"],
                      "createdBy": g["created_by"]},
            "members": members, "expenses": expenses, "payments": payments,
            "notifications": notifs, "payInfo": payinfo,
            "myMemberId": mine["id"] if mine else None}


def claim_ghosts(conn, user_id, username):
    """Когда человек зашёл — занимает все призрачные места со своим @username."""
    u = norm_username(username)
    if not u:
        return
    ex(conn, "UPDATE members SET user_id=? WHERE claim_username=? AND user_id IS NULL", (user_id, u))


def upsert_user(conn, tg_id, username, name):
    row = None
    if tg_id:
        row = ex(conn, "SELECT * FROM users WHERE tg_id=?", (str(tg_id),)).fetchone()
    if not row and username:
        row = ex(conn, "SELECT * FROM users WHERE username=?", (norm_username(username),)).fetchone()
    if row:
        ex(conn, "UPDATE users SET username=?, name=COALESCE(NULLIF(name,''),?) WHERE id=?",
           (norm_username(username), name or row["name"], row["id"]))
        user_id = row["id"]
    else:
        user_id = uid("u")
        n_users = ex(conn, "SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        color = "oklch(0.62 0.14 %d)" % HUES[n_users % len(HUES)]
        ex(conn, "INSERT INTO users(id,tg_id,username,name,color,created) VALUES(?,?,?,?,?,?)",
           (user_id, str(tg_id) if tg_id else None, norm_username(username), name or "Без имени", color, time.time()))
    claim_ghosts(conn, user_id, username)
    return ex(conn, "SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def verify_telegram(init_data):
    """Проверка подписи Telegram WebApp initData. Возвращает dict пользователя или None."""
    if not BOT_TOKEN or not init_data:
        return None
    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    got = pairs.pop("hash", None)
    dcs = "\n".join("%s=%s" % (k, pairs[k]) for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got or ""):
        return None
    try:
        return json.loads(pairs.get("user", "{}"))
    except Exception:
        return None


def tg_api(method, payload):
    """Вызов Telegram Bot API (без зависимостей, через urllib)."""
    if not BOT_TOKEN:
        return None
    url = "https://api.telegram.org/bot%s/%s" % (BOT_TOKEN, method)
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except Exception as e:
        print("tg_api %s error: %s" % (method, e))
        return None


def setup_telegram():
    """Однократно при старте: регистрируем вебхук и кнопку-меню (если есть токен и адрес)."""
    if not BOT_TOKEN or not APP_URL:
        return
    tg_api("setWebhook", {"url": APP_URL + "/api/tg/webhook",
                          "allowed_updates": ["message"]})
    tg_api("setChatMenuButton", {"menu_button": {
        "type": "web_app", "text": "Открыть",
        "web_app": {"url": APP_URL + "/"}}})
    print("  Telegram: webhook → %s/api/tg/webhook" % APP_URL)


# ─────────────────────────── HTTP ───────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CashServer/3.0"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, status=400):
        self._json({"error": msg}, status)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _me(self, conn):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        return ex(conn, "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
                  (auth[7:],)).fetchone()

    def _session(self, conn, user_id):
        token = secrets.token_urlsafe(24)
        ex(conn, "INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)", (token, user_id, time.time()))
        u = ex(conn, "SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self._json({"token": token, "user": user_public(u)})

    def do_GET(self):
        p = urlparse(self.path).path
        return self._api("GET", p) if p.startswith("/api/") else self._static(p)

    def do_POST(self):   return self._api("POST", urlparse(self.path).path)
    def do_PUT(self):    return self._api("PUT", urlparse(self.path).path)
    def do_DELETE(self): return self._api("DELETE", urlparse(self.path).path)

    def _api(self, method, path):
        conn = get_conn()
        try:
            # ---- открытые маршруты (без сессии) ----
            if method == "GET" and path == "/api/config":
                return self._json({"telegram": bool(BOT_TOKEN), "devLogin": DEV_LOGIN,
                                   "bot": BOT_USERNAME, "app": BOT_APP, "ver": "v3-myshare"})
            if method == "GET" and path == "/api/health":
                return self._json({"ok": True})

            if method == "POST" and path == "/api/auth/telegram":
                tg = verify_telegram(self._body().get("initData"))
                if not tg:
                    return self._err("Не удалось проверить Telegram-подпись.", 401)
                u = upsert_user(conn, tg.get("id"), tg.get("username"),
                                (tg.get("first_name", "") + " " + tg.get("last_name", "")).strip())
                return self._session(conn, u["id"])

            if method == "POST" and path == "/api/auth/dev":
                if not DEV_LOGIN:
                    return self._err("Dev-логин выключен в продакшне.", 403)
                d = self._body()
                un = norm_username(d.get("username"))
                if not un:
                    return self._err("Нужен username.")
                u = upsert_user(conn, None, un, d.get("name") or un)
                return self._session(conn, u["id"])

            if method == "POST" and path == "/api/tg/webhook":
                return self._tg_webhook(conn, self._body())

            # ---- дальше нужна сессия ----
            me = self._me(conn)
            if me is None:
                return self._err("Нужно войти.", 401)
            me_id = me["id"]

            if method == "POST" and path == "/api/auth/logout":
                ex(conn, "DELETE FROM sessions WHERE token=?", (self.headers.get("Authorization", "")[7:],))
                return self._json({"ok": True})

            if method == "GET" and path == "/api/me":
                return self._json({"user": user_public(me)})

            if method == "PUT" and path == "/api/me/profile":
                d = self._body()
                ex(conn, "UPDATE users SET name=COALESCE(NULLIF(?,''),name), pay_phone=?, pay_bank=? WHERE id=?",
                   (d.get("name") or "", d.get("payPhone") or "", d.get("payBank") or "", me_id))
                u = ex(conn, "SELECT * FROM users WHERE id=?", (me_id,)).fetchone()
                return self._json({"user": user_public(u)})

            if method == "GET" and path == "/api/groups":
                return self._json({"groups": self._my_groups(conn, me_id), "user": user_public(me)})

            if method == "POST" and path == "/api/groups":
                return self._create_group(conn, me, self._body())

            if method == "POST" and path == "/api/groups/join":
                return self._join_group(conn, me, self._body().get("code"))

            if method == "POST" and path == "/api/groups/claim":
                return self._claim_seat(conn, me, self._body())

            if method == "GET" and path == "/api/groups/preview":
                code = (parse_qs(urlparse(self.path).query).get("code") or [""])[0]
                g = ex(conn, "SELECT * FROM groups WHERE invite_code=?", (code,)).fetchone()
                if not g:
                    return self._err("Группа не найдена.", 404)
                cnt = ex(conn, "SELECT COUNT(*) AS c FROM members WHERE group_id=?", (g["id"],)).fetchone()["c"]
                return self._json({"group": {"name": g["name"], "members": cnt}})

            m = re.match(r"^/api/groups/([\w\-]+)$", path)
            if m and method == "GET":
                gid = m.group(1)
                if not my_member(conn, gid, me_id):
                    return self._err("Вы не участник этой группы.", 403)
                st = group_state(conn, gid, me_id)
                st["me"] = user_public(me)
                return self._json(st)
            if m and method == "DELETE":
                return self._delete_group(conn, me, m.group(1))

            m = re.match(r"^/api/groups/([\w\-]+)/leave$", path)
            if m and method == "POST":
                return self._leave_group(conn, me, m.group(1))

            m = re.match(r"^/api/groups/([\w\-]+)/expenses$", path)
            if m and method == "POST":
                return self._save_expense(conn, me, m.group(1), self._body(), None)

            m = re.match(r"^/api/groups/([\w\-]+)/payments$", path)
            if m and method == "POST":
                return self._create_payment(conn, me, m.group(1), self._body())

            m = re.match(r"^/api/expenses/([\w\-]+)$", path)
            if m and method in ("PUT", "DELETE"):
                return self._mutate_expense(conn, me, m.group(1), method, self._body() if method == "PUT" else None)

            m = re.match(r"^/api/payments/([\w\-]+)/(confirm|dispute)$", path)
            if m and method == "POST":
                return self._resolve_payment(conn, me, m.group(1), m.group(2))

            m = re.match(r"^/api/members/([\w\-]+)$", path)
            if m and method == "PUT":
                return self._rename_member(conn, me, m.group(1), self._body())
            if m and method == "DELETE":
                return self._delete_member(conn, me, m.group(1))

            if method == "POST" and path == "/api/notifications/read":
                ex(conn, "UPDATE notifications SET read=1 WHERE user_id=?", (me_id,))
                return self._json({"ok": True})

            return self._err("Не найдено.", 404)
        except Exception as e:
            return self._err("Ошибка сервера: %s" % e, 500)
        finally:
            release(conn)

    # ---- группы ----
    def _my_groups(self, conn, me_id):
        rows = ex(conn, "SELECT g.* FROM groups g JOIN members m ON m.group_id=g.id "
                  "WHERE m.user_id=? ORDER BY g.created DESC", (me_id,)).fetchall()
        out = []
        for g in rows:
            cnt = ex(conn, "SELECT COUNT(*) AS c FROM members WHERE group_id=?", (g["id"],)).fetchone()["c"]
            out.append({"id": g["id"], "name": g["name"], "inviteCode": g["invite_code"], "memberCount": cnt})
        return out

    def _create_group(self, conn, me, d):
        name = (d.get("name") or "").strip()
        if not name:
            return self._err("Нужно название группы.")
        gid = uid("g")
        code = secrets.token_urlsafe(7)
        ex(conn, "INSERT INTO groups(id,name,invite_code,created_by,created) VALUES(?,?,?,?,?)",
           (gid, name, code, me["id"], time.time()))
        # место создателя — сразу занято
        idx = 0
        ex(conn, "INSERT INTO members(id,group_id,display_name,claim_username,user_id,color,created) VALUES(?,?,?,?,?,?,?)",
           (uid("m"), gid, me["name"], me["username"], me["id"], "oklch(0.62 0.14 %d)" % HUES[0], time.time()))
        # призраки
        for mem in (d.get("members") or []):
            idx += 1
            dn = (mem.get("name") or "").strip() or (norm_username(mem.get("username")) or "Участник")
            dn = unique_name(conn, gid, dn)
            ex(conn, "INSERT INTO members(id,group_id,display_name,claim_username,user_id,color,created) VALUES(?,?,?,?,?,?,?)",
               (uid("m"), gid, dn, norm_username(mem.get("username")), None,
                "oklch(0.62 0.14 %d)" % HUES[idx % len(HUES)], time.time()))
        # вдруг кто-то из призраков — уже зарегистрированный пользователь: пусть займёт сразу
        for r in ex(conn, "SELECT * FROM members WHERE group_id=? AND user_id IS NULL AND claim_username IS NOT NULL", (gid,)).fetchall():
            u = ex(conn, "SELECT id FROM users WHERE username=?", (r["claim_username"],)).fetchone()
            if u:
                ex(conn, "UPDATE members SET user_id=? WHERE id=?", (u["id"], r["id"]))
        st = group_state(conn, gid, me["id"])
        st["me"] = user_public(me)
        return self._json(st)

    def _join_group(self, conn, me, code):
        g = ex(conn, "SELECT * FROM groups WHERE invite_code=?", (code or "",)).fetchone()
        if not g:
            return self._err("Группа не найдена.", 404)
        gid = g["id"]
        if not my_member(conn, gid, me["id"]):
            # пробуем занять призрака по своему @нику
            claim_ghosts(conn, me["id"], me["username"])
        if my_member(conn, gid, me["id"]):
            st = group_state(conn, gid, me["id"]); st["me"] = user_public(me)
            return self._json(st)
        # совпадения по нику нет — пусть человек сам выберет своё место
        ghosts = [{"id": r["id"], "name": r["display_name"]} for r in
                  ex(conn, "SELECT id, display_name FROM members WHERE group_id=? AND user_id IS NULL ORDER BY created", (gid,)).fetchall()]
        return self._json({"needsClaim": True, "code": code,
                           "group": {"id": gid, "name": g["name"]}, "ghosts": ghosts})

    def _claim_seat(self, conn, me, d):
        g = ex(conn, "SELECT * FROM groups WHERE invite_code=?", (d.get("code") or "",)).fetchone()
        if not g:
            return self._err("Группа не найдена.", 404)
        gid = g["id"]
        mid = d.get("memberId")
        if not my_member(conn, gid, me["id"]):
            if mid:   # занять выбранного призрака
                ghost = ex(conn, "SELECT * FROM members WHERE id=? AND group_id=?", (mid, gid)).fetchone()
                if not ghost or ghost["user_id"]:
                    return self._err("Это место уже занято.", 409)
                ex(conn, "UPDATE members SET user_id=?, claim_username=? WHERE id=?", (me["id"], me["username"], mid))
            else:     # новое место
                idx = ex(conn, "SELECT COUNT(*) AS c FROM members WHERE group_id=?", (gid,)).fetchone()["c"]
                ex(conn, "INSERT INTO members(id,group_id,display_name,claim_username,user_id,color,created) VALUES(?,?,?,?,?,?,?)",
                   (uid("m"), gid, unique_name(conn, gid, me["name"]), me["username"], me["id"],
                    "oklch(0.62 0.14 %d)" % HUES[idx % len(HUES)], time.time()))
        st = group_state(conn, gid, me["id"]); st["me"] = user_public(me)
        return self._json(st)

    def _rename_member(self, conn, me, mid, d):
        mem = ex(conn, "SELECT * FROM members WHERE id=?", (mid,)).fetchone()
        if not mem:
            return self._err("Участник не найден.", 404)
        g = ex(conn, "SELECT * FROM groups WHERE id=?", (mem["group_id"],)).fetchone()
        can = (mem["user_id"] == me["id"]) or (not mem["user_id"] and g and g["created_by"] == me["id"])
        if not can:
            return self._err("Можно менять только своё имя.", 403)
        name = (d.get("name") or "").strip()
        if not name:
            return self._err("Имя не может быть пустым.")
        taken = {r["display_name"] for r in
                 ex(conn, "SELECT id, display_name FROM members WHERE group_id=?", (mem["group_id"],)).fetchall()
                 if r["id"] != mid}
        if name in taken:
            return self._err("Такое имя уже занято в группе.", 409)
        ex(conn, "UPDATE members SET display_name=? WHERE id=?", (name, mid))
        # если переименовал себя — обновим и глобальное имя
        if mem["user_id"] == me["id"]:
            ex(conn, "UPDATE users SET name=? WHERE id=?", (name, me["id"]))
        st = group_state(conn, mem["group_id"], me["id"])
        st["me"] = user_public(me)
        return self._json(st)

    def _member_referenced(self, conn, gid, mid):
        if ex(conn, "SELECT 1 FROM expenses WHERE group_id=? AND (payer=? OR author_member=?)",
              (gid, mid, mid)).fetchone():
            return True
        if ex(conn, "SELECT 1 FROM payments WHERE group_id=? AND (from_member=? OR to_member=?)",
              (gid, mid, mid)).fetchone():
            return True
        for r in ex(conn, "SELECT split FROM expenses WHERE group_id=?", (gid,)).fetchall():
            try:
                sp = json.loads(r["split"] or "{}")
            except Exception:
                sp = {}
            ids = list(sp.get("among") or []) + list((sp.get("shares") or {}).keys()) + list((sp.get("exact") or {}).keys())
            if mid in ids:
                return True
        return False

    def _delete_member(self, conn, me, mid):
        mem = ex(conn, "SELECT * FROM members WHERE id=?", (mid,)).fetchone()
        if not mem:
            return self._err("Участник не найден.", 404)
        g = ex(conn, "SELECT * FROM groups WHERE id=?", (mem["group_id"],)).fetchone()
        if not g or g["created_by"] != me["id"]:
            return self._err("Убирать участников может только создатель группы.", 403)
        if mem["user_id"] == me["id"]:
            return self._err("Себя убрать нельзя — используйте «Выйти из группы».")
        if self._member_referenced(conn, mem["group_id"], mid):
            return self._err("Нельзя убрать: у участника есть траты или переводы. Сначала удалите их.")
        ex(conn, "DELETE FROM members WHERE id=?", (mid,))
        return self._json(group_state(conn, mem["group_id"], me["id"]) | {"me": user_public(me)})

    def _leave_group(self, conn, me, gid):
        mm = my_member(conn, gid, me["id"])
        if not mm:
            return self._err("Вы не участник этой группы.", 403)
        # освобождаем место (становится призраком) — история и долги сохраняются
        ex(conn, "UPDATE members SET user_id=NULL WHERE id=?", (mm["id"],))
        return self._json({"ok": True, "left": True})

    def _delete_group(self, conn, me, gid):
        g = ex(conn, "SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not g:
            return self._err("Группа не найдена.", 404)
        if g["created_by"] != me["id"]:
            return self._err("Удалить группу может только её создатель.", 403)
        ex(conn, "DELETE FROM expenses WHERE group_id=?", (gid,))
        ex(conn, "DELETE FROM payments WHERE group_id=?", (gid,))
        ex(conn, "DELETE FROM members WHERE group_id=?", (gid,))
        ex(conn, "DELETE FROM notifications WHERE group_id=?", (gid,))
        ex(conn, "DELETE FROM groups WHERE id=?", (gid,))
        return self._json({"ok": True, "deleted": True})

    # ---- траты ----
    def _save_expense(self, conn, me, gid, d, _):
        mm = my_member(conn, gid, me["id"])
        if not mm:
            return self._err("Вы не участник этой группы.", 403)
        try:
            amount = float(d.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        payer = d.get("payer")
        if amount <= 0 or not payer:
            return self._err("Нужны сумма и плательщик.")
        if not ex(conn, "SELECT 1 FROM members WHERE id=? AND group_id=?", (payer, gid)).fetchone():
            return self._err("Плательщик не из этой группы.")
        ex(conn, "INSERT INTO expenses(id,group_id,payer,amount,title,category,date,split,author_member,created) "
           "VALUES(?,?,?,?,?,?,?,?,?,?)",
           (uid("e"), gid, payer, amount, d.get("title") or "", d.get("category") or "other",
            d.get("date") or time.strftime("%Y-%m-%d"),
            json.dumps(d.get("split") or {"mode": "equal"}, ensure_ascii=False), mm["id"], time.time()))
        # уведомить в Телеграме тех, кто теперь должен (кроме плательщика и автора)
        shares = _owed_for_expense({"amount": amount, "payer": payer, "split": d.get("split") or {"mode": "equal"}})
        pr = ex(conn, "SELECT display_name FROM members WHERE id=?", (payer,)).fetchone()
        payer_name = pr["display_name"] if pr else "?"
        title = d.get("title") or "трата"
        for pid, k in shares.items():
            if pid == payer or pid == mm["id"] or k <= 0:
                continue
            chat = member_chat_id(conn, pid)
            if chat:
                o, i = personal_totals(conn, gid, pid)
                tg_send(chat, "🧾 Новая трата «%s»\n%s заплатил(а) %s, ваша доля — %s.\n\nВам должны: %s\nВы должны: %s"
                        % (title, payer_name, fmt_k(round(amount * 100)), fmt_k(k), fmt_k(o), fmt_k(i)))
        return self._json(group_state(conn, gid, me["id"]) | {"me": user_public(me)})

    def _mutate_expense(self, conn, me, eid, method, d):
        e = ex(conn, "SELECT * FROM expenses WHERE id=?", (eid,)).fetchone()
        if not e:
            return self._err("Трата не найдена.", 404)
        author = ex(conn, "SELECT * FROM members WHERE id=?", (e["author_member"],)).fetchone()
        if not author or author["user_id"] != me["id"]:
            return self._err("Менять/удалять можно только свои траты.", 403)
        if method == "DELETE":
            ex(conn, "DELETE FROM expenses WHERE id=?", (eid,))
        else:
            try:
                amount = float(d.get("amount") or 0)
            except (TypeError, ValueError):
                amount = 0
            if amount <= 0 or not d.get("payer"):
                return self._err("Нужны сумма и плательщик.")
            ex(conn, "UPDATE expenses SET payer=?,amount=?,title=?,category=?,date=?,split=? WHERE id=?",
               (d.get("payer"), amount, d.get("title") or "", d.get("category") or "other",
                d.get("date") or time.strftime("%Y-%m-%d"),
                json.dumps(d.get("split") or {"mode": "equal"}, ensure_ascii=False), eid))
        return self._json(group_state(conn, e["group_id"], me["id"]) | {"me": user_public(me)})

    # ---- переводы ----
    def _create_payment(self, conn, me, gid, d):
        mm = my_member(conn, gid, me["id"])
        if not mm:
            return self._err("Вы не участник этой группы.", 403)
        to = d.get("to")
        try:
            amount = float(d.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        to_mem = ex(conn, "SELECT * FROM members WHERE id=? AND group_id=?", (to, gid)).fetchone()
        if amount <= 0 or not to_mem:
            return self._err("Нужны сумма и получатель из группы.")
        if to == mm["id"]:
            return self._err("Нельзя перевести самому себе.")
        pid = uid("p")
        ex(conn, "INSERT INTO payments(id,group_id,from_member,to_member,amount,status,note,created) VALUES(?,?,?,?,?,?,?,?)",
           (pid, gid, mm["id"], to, amount, "pending", d.get("note") or "", time.time()))
        notify(conn, to_mem["user_id"], gid, "payment_recorded",
               "%s отметил(а) перевод %s вам" % (mm["display_name"], fmt_rub(amount)),
               {"amount": amount, "paymentId": pid})
        chat = member_chat_id(conn, to)
        if chat:
            o, i = personal_totals(conn, gid, to)
            tg_send(chat, "💸 %s отметил(а) перевод %s вам.\nПодтвердите получение в приложении.\n\nВам должны: %s\nВы должны: %s"
                    % (mm["display_name"], fmt_k(round(amount * 100)), fmt_k(o), fmt_k(i)))
        return self._json(group_state(conn, gid, me["id"]) | {"me": user_public(me)})

    def _resolve_payment(self, conn, me, pid, action):
        p = ex(conn, "SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
        if not p:
            return self._err("Перевод не найден.", 404)
        to_mem = ex(conn, "SELECT * FROM members WHERE id=?", (p["to_member"],)).fetchone()
        if not to_mem or to_mem["user_id"] != me["id"]:
            return self._err("Подтвердить может только получатель.", 403)
        from_mem = ex(conn, "SELECT * FROM members WHERE id=?", (p["from_member"],)).fetchone()
        new = "confirmed" if action == "confirm" else "disputed"
        ex(conn, "UPDATE payments SET status=? WHERE id=?", (new, pid))
        if action == "confirm":
            notify(conn, from_mem["user_id"], p["group_id"], "payment_confirmed",
                   "%s подтвердил(а) получение %s" % (to_mem["display_name"], fmt_rub(p["amount"])), {})
        else:
            notify(conn, from_mem["user_id"], p["group_id"], "payment_disputed",
                   "%s не получил(а) перевод %s — долг вернулся" % (to_mem["display_name"], fmt_rub(p["amount"])), {})
        return self._json(group_state(conn, p["group_id"], me["id"]) | {"me": user_public(me)})

    # ---- Telegram webhook: /start → кнопка запуска мини-аппы ----
    def _tg_webhook(self, conn, update):
        msg = update.get("message") or update.get("edited_message") or {}
        text = (msg.get("text") or "").strip()
        cid = (msg.get("chat") or {}).get("id")
        if cid and text.startswith("/start"):
            parts = text.split(maxsplit=1)
            code = parts[1].strip() if len(parts) > 1 else ""
            open_url = (APP_URL + "/?join=" + code) if (APP_URL and code) else (APP_URL + "/" if APP_URL else "")
            txt = ("Привет! Это «Стажки в расчёте» — делим расходы с друзьями.\n"
                   + ("Нажми кнопку ниже, чтобы войти в группу." if code else "Нажми кнопку ниже, чтобы открыть приложение."))
            payload = {"chat_id": cid, "text": txt}
            if open_url:
                payload["reply_markup"] = {"inline_keyboard": [[
                    {"text": "Открыть приложение", "web_app": {"url": open_url}}]]}
            tg_api("sendMessage", payload)
        return self._json({"ok": True})

    # ---- статика ----
    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        safe = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not safe.startswith(WEB_DIR) or not os.path.isfile(safe):
            return self._err("Не найдено: %s" % path, 404)
        with open(safe, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(safe)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("  %s - %s" % (self.address_string(), fmt % args))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    init_db()
    setup_telegram()
    store = "Postgres (облако)" if USE_PG else "SQLite (локально)"
    auth = "Telegram" if BOT_TOKEN else "dev-логин (локально)"
    print("\n  «Стажки в расчёте» v3 (группы)")
    print("  Хранилище: %s | Вход: %s | Порт: %d\n" % (store, auth, PORT))
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Остановлено.")


if __name__ == "__main__":
    main()
