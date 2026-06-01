// app.jsx — «Стажки в расчёте». Многопользовательская версия с входом,
// личной разбивкой долгов, переводами и уведомлениями. Данные с сервера (server.py).
const { useState, useEffect, useMemo } = React;
const S = window.Settle;
const APP_NAME = "Стажки в расчёте";

// ───────────────────────── API-клиент ─────────────────────────
const TOKEN_KEY = "kkd-token";
const tok = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
};
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  const t = tok.get();
  if (t) headers["Authorization"] = "Bearer " + t;
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || ("Ошибка " + res.status));
  return data;
}

// ───────────────────────── тема ─────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem("kkd-theme") === "dark");
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = dark ? "dark" : "light";
    r.dataset.density = "regular";
    r.style.setProperty("--accent", "#5b5bd6");
    r.style.setProperty("--r", "15px");
    r.style.setProperty("--font-sans", "'Hanken Grotesk',system-ui,sans-serif");
    localStorage.setItem("kkd-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, setDark];
}

// ───────────────────────── утилиты ─────────────────────────
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const now = new Date(); now.setHours(0,0,0,0);
  const diff = Math.round((now - d) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.getDate() + " " + MONTHS[d.getMonth()];
}
function fmtTime(epoch) {
  const d = new Date(epoch * 1000), now = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return hh + ":" + mm;
  return d.getDate() + " " + MONTHS[d.getMonth()] + ", " + hh + ":" + mm;
}
function parseAmount(s) {
  const n = parseFloat(String(s).replace(",", ".").replace(/\s/g, ""));
  return isNaN(n) ? 0 : n;
}
function expenseInvolves(exp, uid) {
  if (exp.payer === uid) return true;
  const sp = exp.split || {};
  if (sp.mode === "equal") return (sp.among || []).includes(uid);
  if (sp.mode === "shares") return (sp.shares || {})[uid] > 0;
  if (sp.mode === "exact") return (sp.exact || {})[uid] != null;
  return false;
}
function splitCount(exp) {
  const sp = exp.split || {};
  if (sp.mode === "equal") return (sp.among || []).length;
  if (sp.mode === "shares") return Object.values(sp.shares || {}).filter((v) => v > 0).length;
  if (sp.mode === "exact") return Object.keys(sp.exact || {}).length;
  return 0;
}
function pluralPeople(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "участник";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "участника";
  return "участников";
}
function pluralTransfer(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "перевод";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "перевода";
  return "переводов";
}

// Личная разбивка относительно меня: нетто по парам (с учётом переводов) + «за что».
// c — вклад строки в «мне должны» (копейки): + они мне, − я им.
function personalBreakdown(meId, users, expenses, payments) {
  const ids = users.map((u) => u.id);
  const nameOf = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const per = {};
  const ensure = (id) => (per[id] = per[id] || { id, name: nameOf[id] || id, net: 0, items: [] });

  expenses.forEach((exp) => {
    const owed = S.owedForExpense(exp, ids);
    if (exp.payer === meId) {
      Object.entries(owed).forEach(([pid, k]) => {
        if (pid === meId || k <= 0) return;
        const e = ensure(pid); e.net += k; e.items.push({ c: k, type: "expense", exp });
      });
    } else if (owed[meId] != null && owed[meId] > 0) {
      const e = ensure(exp.payer); e.net -= owed[meId];
      e.items.push({ c: -owed[meId], type: "expense", exp });
    }
  });
  (payments || []).forEach((p) => {
    const k = Math.round(p.amount * 100);
    if (p.from === meId) { const e = ensure(p.to); e.net += k; e.items.push({ c: k, type: "payment", payment: p, sent: true }); }
    else if (p.to === meId) { const e = ensure(p.from); e.net -= k; e.items.push({ c: -k, type: "payment", payment: p, sent: false }); }
  });

  const tOf = (it) => (it.type === "payment" ? (it.payment.created || 0)
    : new Date((it.exp.date || "1970-01-01") + "T00:00:00").getTime() / 1000);
  const owedToMe = [], iOwe = [];
  Object.values(per).forEach((e) => {
    e.items.sort((a, b) => tOf(b) - tOf(a));
    if (e.net > 0) owedToMe.push(e);
    else if (e.net < 0) iOwe.push(e);
  });
  owedToMe.sort((a, b) => b.net - a.net);
  iOwe.sort((a, b) => a.net - b.net);
  return {
    owedToMe, iOwe,
    totalOwedToMe: owedToMe.reduce((a, e) => a + e.net, 0),
    totalIOwe: iOwe.reduce((a, e) => a - e.net, 0),
  };
}

// ───────────────────────── разбивка: строки ─────────────────────────
function BreakdownItem({ it }) {
  if (it.type === "payment") {
    const pos = it.c > 0;
    const st = it.payment.status;
    const stTxt = st === "confirmed" ? "✓ подтверждён" : st === "disputed" ? "оспорен" : "ждёт подтверждения";
    return (
      <div className="pd-item">
        <div className="pd-cat" style={{ color: "var(--accent)" }}><Ic.send /></div>
        <div style={{ minWidth: 0 }}>
          <div className="pd-ititle">{it.sent ? "Перевод — вы отправили" : "Перевод — вам отправили"}</div>
          <div className="pd-istatus">{stTxt}</div>
        </div>
        <span className={"pd-iamt num " + (pos ? "pos" : "neg")}>{(pos ? "+" : "−") + S.fmt(Math.abs(it.c))}</span>
      </div>
    );
  }
  const cat = (window.CATEGORIES.find((c) => c.id === it.exp.category)) || window.CATEGORIES[0];
  const Icn = cat.icon, pos = it.c > 0;
  return (
    <div className="pd-item">
      <div className="pd-cat" style={{ color: `oklch(0.56 0.15 ${cat.hue})` }}><Icn /></div>
      <span className="pd-ititle">{it.exp.title || cat.label}</span>
      <span className="pd-idate">{fmtDate(it.exp.date)}</span>
      <span className={"pd-iamt num " + (pos ? "pos" : "neg")}>{(pos ? "+" : "−") + S.fmt(Math.abs(it.c))}</span>
    </div>
  );
}

function DebtorRow({ entry, dir, colorOf, onPay }) {
  const [open, setOpen] = useState(false);
  const amt = dir === "owed" ? entry.net : -entry.net;
  return (
    <div className="pd">
      <button className={"pd-head" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <div className="av" style={{ background: colorOf(entry.id), width: 30, height: 30, fontSize: 12.5 }}>
          {(entry.name || "?")[0]}
        </div>
        <span className="pd-name">{entry.name}</span>
        <span className={"pd-amt num " + (dir === "owed" ? "pos" : "neg")}>{S.fmt(amt)}</span>
        <span className="pd-chev"><Ic.arrow /></span>
      </button>
      {open && (
        <div className="pd-items">
          {entry.items.map((it, i) => <BreakdownItem key={i} it={it} />)}
          {dir === "owe" && (
            <button className="pay-btn" onClick={() => onPay(entry)}>
              <Ic.send /> Я перевёл(а) {entry.name} · {S.fmt(amt)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BalanceSection({ title, total, dir, entries, colorOf, emptyText, onPay }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bd-sec">
      <button className={"bd-head" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <span className="bd-lbl">{title}</span>
        <span className={"bd-total num " + (dir === "owed" ? "pos" : "neg")}>{S.fmt(total)}</span>
        <span className="bd-chev"><Ic.arrow /></span>
      </button>
      {open && (entries.length ? (
        <div className="bd-list">
          {entries.map((e) => <DebtorRow key={e.id} entry={e} dir={dir} colorOf={colorOf} onPay={onPay} />)}
        </div>
      ) : <div className="bd-empty">{emptyText}</div>)}
    </div>
  );
}

// ───────────────────────── диалог перевода ─────────────────────────
function PaymentDialog({ open, peer, defaultAmount, onClose, onConfirm }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setAmount(defaultAmount ? String(defaultAmount) : ""); setBusy(false); } }, [open, defaultAmount]);
  if (!open) return null;
  const amt = parseAmount(amount);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-h"><b>Я перевёл деньги</b>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"
            style={{ width: 34, height: 34, boxShadow: "none", background: "var(--surface-2)" }}><Ic.close /></button>
        </div>
        <div className="sheet-body">
          <div className="pay-peer">
            <div className="av" style={{ background: peer.color }}>{peer.name[0]}</div>
            <div><div style={{ fontSize: 12.5, color: "var(--text-2)" }}>Получатель</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{peer.name}</div></div>
          </div>
          <div className="field">
            <input className="input amount-input" inputMode="decimal" placeholder="0 ₽"
              value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
          </div>
          <p className="hint">Долг уменьшится сразу. {peer.name} получит уведомление и сможет подтвердить
            получение или отметить, что перевод не пришёл.</p>
        </div>
        <div className="sheet-foot">
          <button className="btn-primary" disabled={!(amt > 0) || busy}
            style={{ opacity: amt > 0 && !busy ? 1 : 0.45 }}
            onClick={async () => { setBusy(true); try { await onConfirm(amt); } finally { setBusy(false); } }}>
            Подтвердить перевод {amt > 0 && <span className="num" style={{ marginLeft: 4 }}>· {S.fmt(Math.round(amt * 100))}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── панель уведомлений ─────────────────────────
function NotificationsPanel({ open, notifications, paymentsById, onClose, onConfirm, onDispute }) {
  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-h"><b>Уведомления</b>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"
            style={{ width: 34, height: 34, boxShadow: "none", background: "var(--surface-2)" }}><Ic.close /></button>
        </div>
        <div className="sheet-body" style={{ paddingBottom: 18 }}>
          {!notifications.length && <div className="bd-empty" style={{ padding: "20px 4px" }}>Пока нет уведомлений</div>}
          {notifications.map((n) => {
            const pay = n.data && n.data.paymentId ? paymentsById[n.data.paymentId] : null;
            const canAct = n.type === "payment_recorded" && pay && pay.status === "pending";
            return (
              <div className="ntf" key={n.id}>
                <div className={"ntf-dot " + (n.read ? "read" : "")} />
                <div className="ntf-body">
                  <div className="ntf-text">{n.text}</div>
                  <div className="ntf-time">{fmtTime(n.created)}</div>
                  {canAct && (
                    <div className="ntf-acts">
                      <button className="btn-mini ok" onClick={() => onConfirm(pay.id)}><Ic.check /> Подтвердить</button>
                      <button className="btn-mini no" onClick={() => onDispute(pay.id)}>Не получил</button>
                    </div>
                  )}
                  {n.type === "payment_recorded" && pay && pay.status === "confirmed" &&
                    <div className="ntf-done">✓ подтверждено</div>}
                  {n.type === "payment_recorded" && pay && pay.status === "disputed" &&
                    <div className="ntf-done neg">отмечено как не полученное</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── экран входа ─────────────────────────
function AuthScreen({ onAuthed, dark, setDark }) {
  const [tab, setTab] = useState("login");
  const [nick, setNick] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const body = tab === "login" ? { nick, password: pw } : { nick, password: pw, name };
      const d = await api(tab === "login" ? "/login" : "/register", { method: "POST", body });
      tok.set(d.token);
      await onAuthed();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <button className="icon-btn auth-theme" onClick={() => setDark((v) => !v)} aria-label="Тема">
        {dark ? <Ic.sun /> : <Ic.moon />}
      </button>
      <form className="auth-card card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 21 }}>₽</div>
          <div>
            <div className="auth-title">{APP_NAME}</div>
            <div className="auth-sub">Войдите, чтобы видеть свои расчёты</div>
          </div>
        </div>
        <div className="seg" style={{ display: "flex", width: "100%", margin: "4px 0 4px" }}>
          <button type="button" className={tab === "login" ? "on" : ""} onClick={() => { setTab("login"); setErr(""); }}>Вход</button>
          <button type="button" className={tab === "register" ? "on" : ""} onClick={() => { setTab("register"); setErr(""); }}>Регистрация</button>
        </div>
        <div className="field">
          <div className="flabel">Ник</div>
          <input className="input" value={nick} autoFocus autoComplete="username"
            onChange={(e) => setNick(e.target.value)} placeholder="например, egor" />
        </div>
        {tab === "register" && (
          <div className="field">
            <div className="flabel">Имя (как показывать)</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Егор" />
          </div>
        )}
        <div className="field">
          <div className="flabel">Пароль</div>
          <input className="input" type="password" value={pw} autoComplete="current-password"
            onChange={(e) => setPw(e.target.value)} placeholder="••••••" />
        </div>
        {err && <div className="auth-err">{err}</div>}
        <button className="btn-primary" type="submit" disabled={busy}
          style={{ width: "100%", height: 50, justifyContent: "center", fontSize: 16, marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          {busy ? "…" : tab === "login" ? "Войти" : "Создать аккаунт"}
        </button>
        <div className="auth-hint">
          {tab === "login" ? "Нет аккаунта? Нажмите «Регистрация» выше." : "Уже есть аккаунт? Нажмите «Вход» выше."}
        </div>
      </form>
    </div>
  );
}

// ───────────────────────── главное приложение ─────────────────────────
function App({ me, initial, dark, setDark, onLogout }) {
  const [users, setUsers] = useState(initial.users);
  const [expenses, setExpenses] = useState(initial.expenses);
  const [payments, setPayments] = useState(initial.payments || []);
  const [notifications, setNotifications] = useState(initial.notifications || []);
  const [mode, setMode] = useState("min");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copied, setCopied] = useState(false);
  const [feedMine, setFeedMine] = useState(false);
  const [payTo, setPayTo] = useState(null);     // {id,name,color,amount}
  const [notifOpen, setNotifOpen] = useState(false);

  const applyState = (d) => {
    if (d.users) setUsers(d.users);
    if (d.expenses) setExpenses(d.expenses);
    if (d.payments) setPayments(d.payments);
    if (d.notifications) setNotifications(d.notifications);
  };

  // поллинг изменений (траты, переводы, уведомления друзей)
  useEffect(() => {
    const iv = setInterval(async () => {
      if (sheetOpen || payTo || notifOpen || document.hidden) return;
      try { applyState(await api("/state")); } catch (e) {}
    }, 8000);
    return () => clearInterval(iv);
  }, [sheetOpen, payTo, notifOpen]);

  const activePayments = useMemo(() => payments.filter((p) => p.status !== "disputed"), [payments]);
  const paymentsById = useMemo(() => Object.fromEntries(payments.map((p) => [p.id, p])), [payments]);
  const colorById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.color])), [users]);
  const colorOf = (id) => colorById[id] || "oklch(0.62 0.14 260)";
  const names = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const unread = notifications.filter((n) => !n.read).length;

  const balances = useMemo(() => S.computeBalances(users, expenses, activePayments), [users, expenses, activePayments]);
  const paid = useMemo(() => S.totalPaid(users, expenses), [users, expenses]);
  const transfers = useMemo(
    () => (mode === "min" ? S.minimalTransfers(balances) : S.pairwiseTransfers(users, expenses, activePayments)),
    [mode, balances, users, expenses, activePayments]);
  const totalSpent = useMemo(() => expenses.reduce((a, e) => a + Math.round(e.amount * 100), 0), [expenses]);
  const allSettled = transfers.length === 0 && expenses.length > 0;
  const breakdown = useMemo(() => personalBreakdown(me.id, users, expenses, activePayments),
    [me.id, users, expenses, activePayments]);

  function openNew() { setEditing(null); setSheetOpen(true); }
  function openEdit(exp) { setEditing(exp); setSheetOpen(true); }
  async function onSave(exp) {
    try {
      const isEdit = expenses.some((e) => e.id === exp.id);
      const d = isEdit
        ? await api("/expenses/" + exp.id, { method: "PUT", body: exp })
        : await api("/expenses", { method: "POST", body: exp });
      applyState(d); setSheetOpen(false); setEditing(null);
    } catch (ex) { alert(ex.message); }
  }
  async function onDelete(id) {
    if (!confirm("Удалить эту трату?")) return;
    try { applyState(await api("/expenses/" + id, { method: "DELETE" })); } catch (ex) { alert(ex.message); }
  }
  function openPay(entry) {
    setPayTo({ id: entry.id, name: entry.name, color: colorOf(entry.id), amount: Math.round((-entry.net) / 100) });
  }
  async function confirmPay(amount) {
    try { applyState(await api("/payments", { method: "POST", body: { to: payTo.id, amount } })); setPayTo(null); }
    catch (ex) { alert(ex.message); }
  }
  async function openNotifs() {
    setNotifOpen(true);
    try { applyState(await api("/notifications/read", { method: "POST" })); } catch (e) {}
  }
  async function confirmReceipt(pid) {
    try { applyState(await api("/payments/" + pid + "/confirm", { method: "POST" })); } catch (ex) { alert(ex.message); }
  }
  async function disputeReceipt(pid) {
    try { applyState(await api("/payments/" + pid + "/dispute", { method: "POST" })); } catch (ex) { alert(ex.message); }
  }
  function copyTransfers() {
    const txt = transfers.map((tr) => `${names[tr.from]} → ${names[tr.to]} · ${S.fmt(tr.amount)}`).join("\n");
    try { navigator.clipboard.writeText(txt); } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  }

  const grouped = useMemo(() => {
    let list = [...expenses];
    if (feedMine) list = list.filter((e) => expenseInvolves(e, me.id));
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const g = [];
    list.forEach((e) => {
      const key = fmtDate(e.date);
      let bucket = g.find((x) => x.key === key);
      if (!bucket) { bucket = { key, items: [] }; g.push(bucket); }
      bucket.items.push(e);
    });
    return g;
  }, [expenses, feedMine, me.id]);

  const PartCard = ({ p }) => {
    const b = balances[p.id] || 0;
    const cls = Math.abs(b) < 50 ? "zero" : b > 0 ? "pos" : "neg";
    const isMe = p.id === me.id;
    const label = Math.abs(b) < 50 ? "в расчёте" : b > 0 ? "должны" : "должен";
    return (
      <div className="pcard">
        <div className="av" style={{ background: p.color }}>{p.name[0]}</div>
        <div className="pcard-info">
          <div className="pcard-name">{p.name}{isMe &&
            <span style={{ color: "var(--text-3)", fontWeight: 500 }}> · Вы</span>}</div>
          <div className={"pcard-bal " + cls}>
            {label}{Math.abs(b) >= 50 && <> <span className="num">{S.fmt(Math.abs(b))}</span></>}
          </div>
        </div>
      </div>
    );
  };

  const FeedItem = ({ e, idx }) => {
    const cat = window.CATEGORIES.find((c) => c.id === e.category) || window.CATEGORIES[0];
    const Icn = cat.icon, hue = cat.hue;
    return (
      <div className="fitem" style={{ animationDelay: idx * 0.03 + "s" }}>
        <div className="fcat" style={{
          background: `color-mix(in oklch, oklch(0.6 0.14 ${hue}) 15%, var(--surface))`,
          color: `oklch(0.56 0.15 ${hue})` }}>
          <Icn />
        </div>
        <div className="finfo">
          <div className="ftitle">{e.title}</div>
          <div className="fmeta">
            <span>платил {names[e.payer] || "?"}</span>
            <span className="sepd" />
            <span>{splitCount(e)} {pluralPeople(splitCount(e))}</span>
          </div>
        </div>
        <div className="fright">
          <div className="famt num">{S.fmt(Math.round(e.amount * 100))}</div>
          <button className="fact" onClick={() => openEdit(e)} aria-label="Изменить"><Ic.edit /></button>
          <button className="fact del" onClick={() => onDelete(e.id)} aria-label="Удалить"><Ic.trash /></button>
        </div>
      </div>
    );
  };

  const hasExpenses = expenses.length > 0;

  const TransfersCard = (
    <div className="card card-pad">
      <div className="card-h">
        <span className="card-title">Кто кому скидывает</span>
        <button className="icon-btn" onClick={copyTransfers} aria-label="Скопировать"
          style={{ width: 34, height: 34, color: copied ? "var(--pos)" : "var(--text-2)" }}>
          {copied ? <Ic.check /> : <Ic.copy />}
        </button>
      </div>
      <div className="seg" style={{ display: "flex", width: "100%", marginBottom: 14 }}>
        <button className={mode === "pairs" ? "on" : ""} onClick={() => setMode("pairs")}>По парам</button>
        <button className={mode === "min" ? "on" : ""} onClick={() => setMode("min")}>Минимум переводов</button>
      </div>
      {allSettled ? (
        <div className="empty settled">
          <div className="empty-emoji">🎉</div>
          <div className="empty-t">Все в расчёте</div>
          <div className="empty-d">Никто никому не должен. Красота.</div>
        </div>
      ) : (
        <div className="tlist">
          {transfers.map((tr, i) => (
            <div className="trow" key={i} style={{ animationDelay: i * 0.04 + "s" }}>
              <div className="tparty">
                <div className="av" style={{ background: colorOf(tr.from) }}>{(names[tr.from] || "?")[0]}</div>
                {names[tr.from]}
              </div>
              <div className="tarrow"><Ic.arrow /></div>
              <div className="tparty">
                <div className="av" style={{ background: colorOf(tr.to) }}>{(names[tr.to] || "?")[0]}</div>
                {names[tr.to]}
              </div>
              <div className="tamt num">{S.fmt(tr.amount)}</div>
            </div>
          ))}
          <div className="tcopy-hint">
            {mode === "min"
              ? `Меньше всего переводов — ${transfers.length} ${pluralTransfer(transfers.length)}`
              : "Прямые долги по каждой паре"}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-top">
          <div className="brand"><div className="brand-mark">₽</div>{APP_NAME}</div>
          <div className="hdr-actions">
            <span className="me-chip">
              <span className="av" style={{ background: colorOf(me.id), width: 26, height: 26, fontSize: 11 }}>{me.name[0]}</span>
              <span className="me-name">{me.name}</span>
            </span>
            <button className="icon-btn ntf-btn" onClick={openNotifs} aria-label="Уведомления">
              <Ic.bell />{unread > 0 && <span className="ntf-badge">{unread > 9 ? "9+" : unread}</span>}
            </button>
            <button className="icon-btn" onClick={() => setDark((v) => !v)} aria-label="Тема">
              {dark ? <Ic.sun /> : <Ic.moon />}
            </button>
            <button className="icon-btn" onClick={onLogout} aria-label="Выйти"><Ic.logout /></button>
            <button className="btn-primary show-desktop" onClick={openNew}><Ic.plus /> Новая трата</button>
          </div>
        </div>
      </header>

      {/* Личный баланс */}
      <div className="card card-pad" style={{ marginTop: "var(--gap-lg)" }}>
        <div className="psum">
          <div className="psum-cell">
            <div className="psum-lbl">Вам должны</div>
            <div className="psum-amt pos num">{S.fmt(breakdown.totalOwedToMe)}</div>
          </div>
          <div className="psum-div" />
          <div className="psum-cell">
            <div className="psum-lbl">Вы должны</div>
            <div className="psum-amt neg num">{S.fmt(breakdown.totalIOwe)}</div>
          </div>
        </div>
        <div className="bd">
          <BalanceSection title="Кто вам должен" total={breakdown.totalOwedToMe} dir="owed"
            entries={breakdown.owedToMe} colorOf={colorOf} emptyText="Пока никто вам не должен" />
          <BalanceSection title="Кому должны вы" total={breakdown.totalIOwe} dir="owe"
            entries={breakdown.iOwe} colorOf={colorOf} emptyText="Вы никому не должны" onPay={openPay} />
        </div>
        <div className="summary-sub" style={{ marginTop: 14 }}>
          <span className="chip">Потрачено вместе&nbsp;<span className="num">{S.fmt(totalSpent)}</span></span>
          <span className="chip">{users.length} {pluralPeople(users.length)}</span>
        </div>
      </div>

      {hasExpenses ? (
        <div className="grid">
          <div className="col">
            <div className="card card-pad">
              <div className="card-h"><span className="card-title">Граф расчётов · вы в центре</span></div>
              <SettlementGraph participants={users} balances={balances}
                paid={paid} transfers={transfers} names={names} hubId={me.id} />
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 8,
                fontSize: 12, color: "var(--text-2)", fontWeight: 600 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <i style={{ width: 9, height: 9, borderRadius: 9, background: "var(--pos)" }} />в плюсе</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <i style={{ width: 9, height: 9, borderRadius: 9, background: "var(--neg)" }} />в минусе</span>
              </div>
            </div>
            {TransfersCard}
          </div>

          <div className="col">
            <div className="card card-pad">
              <div className="card-h"><span className="card-title">Участники</span></div>
              <div className="pgrid">
                {users.map((p) => <PartCard key={p.id} p={p} />)}
              </div>
            </div>
            <div className="card card-pad">
              <div className="card-h"><span className="card-title">Траты</span>
                <div className="seg" style={{ marginLeft: "auto" }}>
                  <button className={feedMine ? "" : "on"} onClick={() => setFeedMine(false)}>Все</button>
                  <button className={feedMine ? "on" : ""} onClick={() => setFeedMine(true)}>Мои</button>
                </div>
              </div>
              <div className="feed">
                {grouped.length ? grouped.map((bucket) => (
                  <React.Fragment key={bucket.key}>
                    <div className="fdate-group">{bucket.key}</div>
                    {bucket.items.map((e, i) => <FeedItem key={e.id} e={e} idx={i} />)}
                  </React.Fragment>
                )) : <div className="bd-empty" style={{ padding: "16px 4px" }}>
                  {feedMine ? "Нет трат с вашим участием" : "Трат пока нет"}</div>}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card card-pad" style={{ marginTop: "var(--gap-lg)" }}>
          <div className="empty">
            <div className="empty-emoji">🧾</div>
            <div className="empty-t">Пока нет трат</div>
            <div className="empty-d">Добавьте первую трату — и мы сразу посчитаем, кто кому сколько должен.</div>
            <button className="btn-primary" style={{ marginTop: 14 }} onClick={openNew}><Ic.plus /> Добавить трату</button>
          </div>
        </div>
      )}

      <button className="fab hide-desktop" onClick={openNew} aria-label="Новая трата"><Ic.plus /></button>

      <NewExpenseSheet open={sheetOpen} onClose={() => { setSheetOpen(false); setEditing(null); }}
        onSave={onSave} participants={users} editing={editing} defaultPayer={me.id} />
      <PaymentDialog open={!!payTo} peer={payTo || {}} defaultAmount={payTo ? payTo.amount : 0}
        onClose={() => setPayTo(null)} onConfirm={confirmPay} />
      <NotificationsPanel open={notifOpen} notifications={notifications} paymentsById={paymentsById}
        onClose={() => setNotifOpen(false)} onConfirm={confirmReceipt} onDispute={disputeReceipt} />
    </div>
  );
}

// ───────────────────────── корень ─────────────────────────
function Root() {
  const [dark, setDark] = useTheme();
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [ready, setReady] = useState(false);

  async function loadState() {
    const d = await api("/state");
    setMe(d.me); setData(d);
  }
  useEffect(() => {
    (async () => {
      if (tok.get()) { try { await loadState(); } catch (e) { tok.set(null); } }
      setReady(true);
    })();
  }, []);

  function logout() {
    api("/logout", { method: "POST" }).catch(() => {});
    tok.set(null); setMe(null); setData(null);
  }

  if (!ready) return <div className="boot">Загрузка…</div>;
  if (!me) return <AuthScreen onAuthed={loadState} dark={dark} setDark={setDark} />;
  return <App me={me} initial={data} dark={dark} setDark={setDark} onLogout={logout} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
