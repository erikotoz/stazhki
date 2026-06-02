#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сервер для приложения «Стажки в расчёте».

ДВА режима хранения данных (выбирается автоматически):
  • Локально:  python3 server.py            → SQLite, файл cash.db, без зависимостей.
  • В облаке:  задана переменная DATABASE_URL → Postgres (например, Supabase).

Запуск локально:  python3 server.py   →  http://localhost:8000
"""

import os
import json
import re
import time
import hmac
import hashlib
import secrets
import sqlite3
from urllib.parse import urlparse
import http.server
import socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "cash.db")
WEB_DIR = os.path.join(HERE, "web")
PORT = int(os.environ.get("PORT", "8000"))

DATABASE_URL = os.environ.get("DATABASE_URL")   # если задана → Postgres
USE_PG = bool(DATABASE_URL)
if USE_PG:
    import psycopg
    from psycopg.rows import dict_row

HUES = [262, 214, 304, 188, 338, 28, 152, 48, 95, 240, 12, 280]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".jsx":  "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".png":  "image/png",
}


# ──────────────────── СЛОЙ БАЗЫ ДАННЫХ (SQLite ИЛИ Postgres) ────────────────────
def q(sql):
    # SQLite использует ?, Postgres — %s
    return sql.replace("?", "%s") if USE_PG else sql


def get_conn():
    if USE_PG:
        # prepare_threshold=None — совместимость с пулером Supabase
        return psycopg.connect(DATABASE_URL, row_factory=dict_row,
                               autocommit=True, prepare_threshold=None)
    conn = sqlite3.connect(DB_PATH, isolation_level=None)  # автокоммит
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def ex(conn, sql, params=()):
    return conn.execute(q(sql), params)


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, nick TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        color TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS expenses(
        id TEXT PRIMARY KEY, payer TEXT NOT NULL, amount REAL NOT NULL, title TEXT,
        category TEXT, date TEXT, split TEXT, author TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS payments(
        id TEXT PRIMARY KEY, from_user TEXT NOT NULL, to_user TEXT NOT NULL,
        amount REAL NOT NULL, status TEXT NOT NULL, note TEXT, created REAL NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS notifications(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
        data TEXT, read INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL)""",
]


def init_db():
    conn = get_conn()
    try:
        for stmt in SCHEMA:
            ex(conn, stmt)
    finally:
        conn.close()


# ──────────────────────────────── ПАРОЛИ ────────────────────────────────────
def hash_pw(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                               salt.encode("utf-8"), 120_000).hex()


def check_pw(password, salt, expected):
    return hmac.compare_digest(hash_pw(password, salt), expected)


# ──────────────────────────────── СЕРИАЛИЗАЦИЯ ───────────────────────────────
def user_public(r):
    return {"id": r["id"], "name": r["name"], "color": r["color"]}


def expense_public(r):
    try:
        split = json.loads(r["split"]) if r["split"] else {}
    except Exception:
        split = {}
    return {"id": r["id"], "payer": r["payer"], "amount": r["amount"], "title": r["title"],
            "category": r["category"], "date": r["date"], "split": split}


def payment_public(r):
    return {"id": r["id"], "from": r["from_user"], "to": r["to_user"],
            "amount": r["amount"], "status": r["status"], "note": r["note"], "created": r["created"]}


def notification_public(r):
    try:
        data = json.loads(r["data"]) if r["data"] else {}
    except Exception:
        data = {}
    return {"id": r["id"], "type": r["type"], "text": r["text"],
            "data": data, "read": bool(r["read"]), "created": r["created"]}


def fmt_rub(amount):
    return "{:,}".format(int(round(amount))).replace(",", " ") + " ₽"


def notify(conn, user_id, ntype, text, data):
    ex(conn, "INSERT INTO notifications(id,user_id,type,text,data,read,created) VALUES(?,?,?,?,?,0,?)",
       ("n%d-%s" % (int(time.time() * 1000), secrets.token_hex(2)),
        user_id, ntype, text, json.dumps(data, ensure_ascii=False), time.time()))


def full_state(conn, me_id=None):
    users = [user_public(r) for r in ex(conn, "SELECT * FROM users ORDER BY created").fetchall()]
    expenses = [expense_public(r) for r in ex(conn, "SELECT * FROM expenses ORDER BY date, created").fetchall()]
    payments = [payment_public(r) for r in ex(conn, "SELECT * FROM payments ORDER BY created").fetchall()]
    state = {"users": users, "expenses": expenses, "payments": payments}
    if me_id:
        rows = ex(conn, "SELECT * FROM notifications WHERE user_id=? ORDER BY created DESC LIMIT 50",
                  (me_id,)).fetchall()
        state["notifications"] = [notification_public(r) for r in rows]
    return state


# ──────────────────────────────── HTTP-ХЕНДЛЕР ───────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CashServer/2.0"

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, message, status=400):
        self._send_json({"error": message}, status)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _current_user(self, conn):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        return ex(conn, "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                  "WHERE s.token = ?", (auth[7:],)).fetchone()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._api("GET", path)
        return self._serve_static(path)

    def do_POST(self):   return self._api("POST", urlparse(self.path).path)
    def do_PUT(self):    return self._api("PUT", urlparse(self.path).path)
    def do_DELETE(self): return self._api("DELETE", urlparse(self.path).path)

    def _api(self, method, path):
        conn = get_conn()
        try:
            if method == "POST" and path == "/api/register":
                d = self._read_body()
                nick = (d.get("nick") or "").strip()
                pw = d.get("password") or ""
                name = (d.get("name") or "").strip() or nick
                if len(nick) < 2 or len(pw) < 3:
                    return self._err("Ник от 2 символов, пароль от 3 символов.")
                if ex(conn, "SELECT 1 FROM users WHERE nick=?", (nick,)).fetchone():
                    return self._err("Такой ник уже занят.", 409)
                n_users = ex(conn, "SELECT COUNT(*) AS c FROM users").fetchone()["c"]
                uid = "u" + secrets.token_hex(4)
                salt = secrets.token_hex(16)
                color = "oklch(0.62 0.14 %d)" % HUES[n_users % len(HUES)]
                ex(conn, "INSERT INTO users(id,nick,name,color,pw_salt,pw_hash,created) "
                   "VALUES(?,?,?,?,?,?,?)",
                   (uid, nick, name, color, salt, hash_pw(pw, salt), time.time()))
                return self._issue_session(conn, uid)

            if method == "POST" and path == "/api/login":
                d = self._read_body()
                row = ex(conn, "SELECT * FROM users WHERE nick=?",
                         ((d.get("nick") or "").strip(),)).fetchone()
                if not row or not check_pw(d.get("password") or "", row["pw_salt"], row["pw_hash"]):
                    return self._err("Неверный ник или пароль.", 401)
                return self._issue_session(conn, row["id"])

            me = self._current_user(conn)
            if me is None:
                return self._err("Нужно войти.", 401)

            if method == "GET" and path == "/api/state":
                state = full_state(conn, me["id"])
                state["me"] = user_public(me)
                return self._send_json(state)

            if method == "POST" and path == "/api/logout":
                ex(conn, "DELETE FROM sessions WHERE token=?",
                   (self.headers.get("Authorization", "")[7:],))
                return self._send_json({"ok": True})

            if method == "POST" and path == "/api/expenses":
                return self._save_expense(conn, me, self._read_body(), None)

            m = re.match(r"^/api/expenses/([\w\-]+)$", path)
            if m and method == "PUT":
                return self._save_expense(conn, me, self._read_body(), m.group(1))
            if m and method == "DELETE":
                ex(conn, "DELETE FROM expenses WHERE id=?", (m.group(1),))
                return self._send_json(full_state(conn, me["id"]))

            if method == "POST" and path == "/api/payments":
                return self._create_payment(conn, me, self._read_body())

            mp = re.match(r"^/api/payments/([\w\-]+)/(confirm|dispute)$", path)
            if mp and method == "POST":
                return self._resolve_payment(conn, me, mp.group(1), mp.group(2))

            if method == "POST" and path == "/api/notifications/read":
                ex(conn, "UPDATE notifications SET read=1 WHERE user_id=?", (me["id"],))
                return self._send_json(full_state(conn, me["id"]))

            return self._err("Не найдено.", 404)
        except Exception as e:
            return self._err("Ошибка сервера: %s" % e, 500)
        finally:
            conn.close()

    def _issue_session(self, conn, user_id):
        token = secrets.token_urlsafe(24)
        ex(conn, "INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)",
           (token, user_id, time.time()))
        user = ex(conn, "SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self._send_json({"token": token, "user": user_public(user)})

    def _save_expense(self, conn, me, d, exp_id):
        try:
            amount = float(d.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        payer = d.get("payer")
        if amount <= 0 or not payer:
            return self._err("Нужны сумма и плательщик.")
        if not ex(conn, "SELECT 1 FROM users WHERE id=?", (payer,)).fetchone():
            return self._err("Неизвестный плательщик.")
        split = json.dumps(d.get("split") or {"mode": "equal"}, ensure_ascii=False)
        title = d.get("title") or ""
        category = d.get("category") or "other"
        date = d.get("date") or time.strftime("%Y-%m-%d")
        if exp_id:
            ex(conn, "UPDATE expenses SET payer=?,amount=?,title=?,category=?,date=?,split=? WHERE id=?",
               (payer, amount, title, category, date, split, exp_id))
        else:
            new_id = "e%d-%s" % (int(time.time() * 1000), secrets.token_hex(2))
            ex(conn, "INSERT INTO expenses(id,payer,amount,title,category,date,split,author,created) "
               "VALUES(?,?,?,?,?,?,?,?,?)",
               (new_id, payer, amount, title, category, date, split, me["id"], time.time()))
        return self._send_json(full_state(conn, me["id"]))

    def _create_payment(self, conn, me, d):
        to = d.get("to")
        try:
            amount = float(d.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        if amount <= 0 or not to:
            return self._err("Нужны сумма и получатель.")
        if to == me["id"]:
            return self._err("Нельзя перевести самому себе.")
        peer = ex(conn, "SELECT * FROM users WHERE id=?", (to,)).fetchone()
        if not peer:
            return self._err("Неизвестный получатель.")
        pid = "p%d-%s" % (int(time.time() * 1000), secrets.token_hex(2))
        ex(conn, "INSERT INTO payments(id,from_user,to_user,amount,status,note,created) "
           "VALUES(?,?,?,?,?,?,?)", (pid, me["id"], to, amount, "pending", d.get("note") or "", time.time()))
        notify(conn, to, "payment_recorded",
               "%s отметил(а) перевод %s вам" % (me["name"], fmt_rub(amount)),
               {"paymentId": pid, "amount": amount, "from": me["id"]})
        return self._send_json(full_state(conn, me["id"]))

    def _resolve_payment(self, conn, me, pid, action):
        pay = ex(conn, "SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
        if not pay:
            return self._err("Перевод не найден.", 404)
        if pay["to_user"] != me["id"]:
            return self._err("Только получатель может подтвердить перевод.", 403)
        amount = pay["amount"]
        if action == "confirm":
            ex(conn, "UPDATE payments SET status='confirmed' WHERE id=?", (pid,))
            notify(conn, pay["from_user"], "payment_confirmed",
                   "%s подтвердил(а) получение %s" % (me["name"], fmt_rub(amount)),
                   {"paymentId": pid, "amount": amount})
        else:
            ex(conn, "UPDATE payments SET status='disputed' WHERE id=?", (pid,))
            notify(conn, pay["from_user"], "payment_disputed",
                   "%s не получил(а) перевод %s — долг вернулся" % (me["name"], fmt_rub(amount)),
                   {"paymentId": pid, "amount": amount})
        return self._send_json(full_state(conn, me["id"]))

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        safe = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not safe.startswith(WEB_DIR) or not os.path.isfile(safe):
            return self._err("Не найдено: %s" % path, 404)
        ext = os.path.splitext(safe)[1].lower()
        with open(safe, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
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
    mode = "Postgres (облако)" if USE_PG else "SQLite (локально, cash.db)"
    print("\n  ╭───────────────────────────────────────────────╮")
    print("  │   «Стажки в расчёте» — сервер запущен           │")
    print("  │   Хранилище: %-33s│" % mode)
    print("  │   Порт: %-5d                                  │" % PORT)
    print("  ╰───────────────────────────────────────────────╯\n")
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Остановлено.")


if __name__ == "__main__":
    main()
