// app.jsx — «Стажки в расчёте». Версия с ГРУППАМИ.
// Экран групп → группа (балансы, граф, переводы, лента) → настройки.
// Данные с сервера (server.py). Участники группы — «места» (member), могут быть призраками.
const { useState, useEffect, useMemo, useRef } = React;
const S = window.Settle;
const APP_NAME = "Стажки в расчёте";

// Telegram WebApp (если открыто внутри Телеграма)
const TG = window.Telegram && window.Telegram.WebApp;
const inTelegram = !!(TG && TG.initData);
let CFG = { telegram: false, devLogin: true, bot: "stazhki_v_raschete_bot", app: "app" };

// Подтверждение: в Телеграме — нативное окно, иначе — обычный confirm
function confirmDialog(message) {
  return new Promise((resolve) => {
    try {
      if (inTelegram && TG.showConfirm) { TG.showConfirm(message, (ok) => resolve(!!ok)); return; }
    } catch (e) {}
    resolve(window.confirm(message));
  });
}

// ───────────────────────── API ─────────────────────────
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
    method: opts.method || "GET", headers,
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
function expenseInvolves(exp, id) {
  if (exp.payer === id) return true;
  const sp = exp.split || {};
  if (sp.mode === "equal") return (sp.among || []).includes(id);
  if (sp.mode === "shares") return (sp.shares || {})[id] > 0;
  if (sp.mode === "exact") return (sp.exact || {})[id] != null;
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

// Личная разбивка относительно моего места: нетто по парам (с учётом переводов) + «за что».
function personalBreakdown(meId, members, expenses, payments) {
  const ids = members.map((u) => u.id);
  const nameOf = Object.fromEntries(members.map((u) => [u.id, u.name]));
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
  return { owedToMe, iOwe,
    totalOwedToMe: owedToMe.reduce((a, e) => a + e.net, 0),
    totalIOwe: iOwe.reduce((a, e) => a - e.net, 0) };
}

// ───────────────────────── разбивка: строки ─────────────────────────
function BreakdownItem({ it }) {
  if (it.type === "payment") {
    const pos = it.c > 0, st = it.payment.status;
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

function DebtorRow({ entry, dir, colorOf, onPay, payInfo }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const amt = dir === "owed" ? entry.net : -entry.net;
  const pi = payInfo && payInfo[entry.id];
  const hasReq = pi && (pi.payPhone || pi.payBank);
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
          {dir === "owe" && hasReq && (
            <div className="pay-req">
              <div className="pay-req-info">
                <div className="pay-req-l">Куда перевести {entry.name}</div>
                <div className="pay-req-v num">{[pi.payPhone, pi.payBank].filter(Boolean).join("  ·  ")}</div>
              </div>
              <button className="icon-btn" style={{ width: 32, height: 32 }} aria-label="Скопировать"
                onClick={() => { try { navigator.clipboard.writeText(pi.payPhone || pi.payBank || ""); } catch (e) {}
                  setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
                {copied ? <Ic.check /> : <Ic.copy />}
              </button>
            </div>
          )}
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

function BalanceSection({ title, total, dir, entries, colorOf, emptyText, onPay, payInfo }) {
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
          {entries.map((e) => <DebtorRow key={e.id} entry={e} dir={dir} colorOf={colorOf} onPay={onPay} payInfo={payInfo} />)}
        </div>
      ) : <div className="bd-empty">{emptyText}</div>)}
    </div>
  );
}

// ───────────────────────── диалог перевода ─────────────────────────
function PaymentDialog({ open, peer, defaultAmount, onClose, onConfirm }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => { if (open) { setAmount(defaultAmount ? String(defaultAmount) : ""); setBusy(false); submitting.current = false; } }, [open, defaultAmount]);
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
            <div className="av" style={{ background: peer.color }}>{(peer.name || "?")[0]}</div>
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
            onClick={async () => { if (submitting.current) return; submitting.current = true; setBusy(true);
              try { await onConfirm(amt); } finally { submitting.current = false; setBusy(false); } }}>
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
                  {n.type === "payment_recorded" && pay && pay.status === "confirmed" && <div className="ntf-done">✓ подтверждено</div>}
                  {n.type === "payment_recorded" && pay && pay.status === "disputed" && <div className="ntf-done neg">отмечено как не полученное</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── настройки (имя + реквизиты) ─────────────────────────
function SettingsSheet({ open, initial, onClose, onSave, group }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [bank, setBank] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setName(initial.name || ""); setPhone(initial.payPhone || ""); setBank(initial.payBank || ""); setBusy(false); }
  }, [open]);
  if (!open) return null;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-h"><b>Настройки</b>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"
            style={{ width: 34, height: 34, boxShadow: "none", background: "var(--surface-2)" }}><Ic.close /></button>
        </div>
        <div className="sheet-body">
          <div className="field">
            <div className="flabel">Ваше имя</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас показывать" />
          </div>
          <div className="field">
            <div className="flabel">Номер для перевода</div>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 999 123-45-67" />
          </div>
          <div className="field">
            <div className="flabel">Банк</div>
            <input className="input" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Например, Тинькофф" />
          </div>
          <p className="hint">Номер и банк видят те, кто должен вам — чтобы знать, куда перевести.</p>
          {group && (
            <div className="danger">
              <div className="danger-h">Группа «{group.name}»</div>
              <button className="danger-btn" onClick={group.onLeave}><Ic.logout /> Выйти из группы</button>
              {group.isCreator && <button className="danger-btn del" onClick={group.onDelete}><Ic.trash /> Удалить группу</button>}
            </div>
          )}
        </div>
        <div className="sheet-foot">
          <button className="btn-primary" disabled={busy} style={{ opacity: busy ? 0.5 : 1 }}
            onClick={async () => { setBusy(true); try { await onSave({ name: name.trim(), payPhone: phone.trim(), payBank: bank.trim() }); } finally { setBusy(false); } }}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── создание группы ─────────────────────────
function CreateGroupSheet({ open, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [rows, setRows] = useState([{ name: "", username: "" }, { name: "", username: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (open) { setName(""); setRows([{ name: "", username: "" }, { name: "", username: "" }]); setErr(""); setBusy(false); } }, [open]);
  if (!open) return null;
  const setRow = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  async function submit() {
    setErr("");
    if (!name.trim()) { setErr("Введите название группы."); return; }
    const members = rows.filter((r) => r.name.trim() || r.username.trim())
      .map((r) => ({ name: r.name.trim(), username: r.username.trim() }));
    setBusy(true);
    try { onCreated(await api("/groups", { method: "POST", body: { name: name.trim(), members } })); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-h"><b>Новая группа</b>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"
            style={{ width: 34, height: 34, boxShadow: "none", background: "var(--surface-2)" }}><Ic.close /></button>
        </div>
        <div className="sheet-body">
          <div className="field">
            <div className="flabel">Название</div>
            <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Поездка в горы" />
          </div>
          <div className="field">
            <div className="flabel">Участники</div>
            <p className="hint" style={{ marginTop: -2 }}>Впишите имя и (если есть) @ник в Телеграме. Пока человек не зашёл,
              он «призрак» — за него уже можно заносить траты. Себя добавлять не нужно.</p>
            <div className="cg-list">
              {rows.map((r, i) => (
                <div className="cg-row" key={i}>
                  <input className="input" value={r.name} placeholder="Имя"
                    onChange={(e) => setRow(i, "name", e.target.value)} />
                  <input className="input" value={r.username} placeholder="@ник (необязательно)"
                    onChange={(e) => setRow(i, "username", e.target.value)} />
                  <button className="icon-btn" style={{ width: 38, flex: "0 0 auto" }} aria-label="Убрать"
                    onClick={() => setRows((rr) => rr.filter((_, j) => j !== i))}><Ic.close /></button>
                </div>
              ))}
            </div>
            <button className="add-row" onClick={() => setRows((r) => [...r, { name: "", username: "" }])}>
              <Ic.plus /> Ещё участник
            </button>
          </div>
          {err && <div className="auth-err">{err}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn-primary" disabled={busy} style={{ opacity: busy ? 0.5 : 1 }} onClick={submit}>
            Создать группу
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── заглушка вне Телеграма ─────────────────────────
function LockScreen({ bot, diag }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card card" style={{ textAlign: "center", alignItems: "center" }}>
        <div className="brand-mark" style={{ width: 46, height: 46, fontSize: 24, margin: "0 auto" }}>₽</div>
        <div className="auth-title" style={{ marginTop: 12 }}>{APP_NAME}</div>
        <p className="auth-sub" style={{ marginTop: 8 }}>Приложение работает внутри Телеграма.</p>
        <a className="btn-primary" href={"https://t.me/" + bot} target="_blank" rel="noreferrer"
          style={{ justifyContent: "center", marginTop: 14, textDecoration: "none", width: "100%", height: 48 }}>
          Открыть @{bot}
        </a>
        {diag && <p style={{ marginTop: 14, fontSize: 11.5, color: "var(--text-3)", wordBreak: "break-word" }}>отладка: {diag}</p>}
      </div>
    </div>
  );
}

// ───────────────────────── экран входа (dev-логин; в Телеграме станет авто) ─────────────────────────
function AuthScreen({ onAuthed, dark, setDark }) {
  const [un, setUn] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const d = await api("/auth/dev", { method: "POST", body: { username: un.trim(), name: name.trim() } });
      tok.set(d.token); await onAuthed();
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
            <div className="auth-sub">Локальный вход (в Телеграме будет автоматически)</div>
          </div>
        </div>
        <div className="field">
          <div className="flabel">Ник (@username)</div>
          <input className="input" value={un} autoFocus autoComplete="username"
            onChange={(e) => setUn(e.target.value)} placeholder="например, egor" />
        </div>
        <div className="field">
          <div className="flabel">Имя</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Егор" />
        </div>
        {err && <div className="auth-err">{err}</div>}
        <button className="btn-primary" type="submit" disabled={busy}
          style={{ width: "100%", height: 50, justifyContent: "center", fontSize: 16, marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          {busy ? "…" : "Войти"}
        </button>
      </form>
    </div>
  );
}

// ───────────────────────── экран списка групп ─────────────────────────
function GroupsScreen({ me, groups, dark, setDark, onOpen, onCreated, onLogout, reload }) {
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  async function saveProfile(v) {
    await api("/me/profile", { method: "PUT", body: v });
    await reload(); setSettings(false);
  }
  async function join() {
    if (!joinCode.trim()) return;
    setJoining(true);
    try { onCreated(await api("/groups/join", { method: "POST", body: { code: joinCode.trim() } })); }
    catch (ex) { alert(ex.message); } finally { setJoining(false); }
  }

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-top">
          <div className="brand"><div className="brand-mark">₽</div>{APP_NAME}</div>
          <div className="hdr-actions">
            <span className="me-chip">
              <span className="av" style={{ background: me.color, width: 26, height: 26, fontSize: 11 }}>{(me.name || "?")[0]}</span>
              <span className="me-name">{me.name}</span>
            </span>
            <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Настройки"><Ic.gear /></button>
            <button className="icon-btn" onClick={() => setDark((v) => !v)} aria-label="Тема">{dark ? <Ic.sun /> : <Ic.moon />}</button>
            {!inTelegram && <button className="icon-btn" onClick={onLogout} aria-label="Выйти"><Ic.logout /></button>}
          </div>
        </div>
      </header>

      <div className="card card-pad" style={{ marginTop: "var(--gap-lg)" }}>
        <div className="card-h"><span className="card-title">Ваши группы</span></div>
        {groups.length ? (
          <div className="glist">
            {groups.map((g) => (
              <button className="gcard" key={g.id} onClick={() => onOpen(g.id)}>
                <div className="gcard-mark"><Ic.users /></div>
                <div className="gcard-info">
                  <div className="gcard-name">{g.name}</div>
                  <div className="gcard-sub">{g.memberCount} {pluralPeople(g.memberCount)}</div>
                </div>
                <Ic.arrow />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">
            <div className="empty-emoji">👥</div>
            <div className="empty-t">Пока нет групп</div>
            <div className="empty-d">Создайте группу для своей компании — и заносите траты.</div>
          </div>
        )}
        <button className="btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
          onClick={() => setCreating(true)}><Ic.plus /> Создать группу</button>
      </div>

      <div className="card card-pad">
        <div className="card-h"><span className="card-title">Войти по коду приглашения</span></div>
        <div className="row" style={{ display: "flex", gap: 8 }}>
          <input className="input" value={joinCode} placeholder="код из ссылки"
            onChange={(e) => setJoinCode(e.target.value)} style={{ flex: 1 }} />
          <button className="btn-primary" style={{ flex: "0 0 auto" }} disabled={joining} onClick={join}>Войти</button>
        </div>
      </div>

      <CreateGroupSheet open={creating} onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); onCreated(d); }} />
      <SettingsSheet open={settings} initial={me} onClose={() => setSettings(false)} onSave={saveProfile} />
    </div>
  );
}

// ───────────────────────── группа ─────────────────────────
function GroupView({ initial, dark, setDark, onBack }) {
  const groupMeta = initial.group;
  const gid = groupMeta.id;
  const [members, setMembers] = useState(initial.members);
  const [expenses, setExpenses] = useState(initial.expenses);
  const [payments, setPayments] = useState(initial.payments || []);
  const [notifications, setNotifications] = useState(initial.notifications || []);
  const [payInfo, setPayInfo] = useState(initial.payInfo || {});
  const [meUser, setMeUser] = useState(initial.me);
  const [mode, setMode] = useState("min");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copied, setCopied] = useState(false);
  const [invCopied, setInvCopied] = useState(false);
  const [feedMine, setFeedMine] = useState(false);
  const [payTo, setPayTo] = useState(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [settings, setSettings] = useState(false);

  const meMid = useMemo(() => (members.find((m) => m.isMe) || {}).id || initial.myMemberId, [members]);
  const isCreator = meUser.id === groupMeta.createdBy;

  const applyState = (d) => {
    if (d.members) setMembers(d.members);
    if (d.expenses) setExpenses(d.expenses);
    if (d.payments) setPayments(d.payments);
    if (d.notifications) setNotifications(d.notifications);
    if (d.payInfo) setPayInfo(d.payInfo);
    if (d.me) setMeUser(d.me);
  };

  useEffect(() => {
    const iv = setInterval(async () => {
      if (sheetOpen || payTo || notifOpen || settings || document.hidden) return;
      try { applyState(await api("/groups/" + gid)); } catch (e) {}
    }, 8000);
    return () => clearInterval(iv);
  }, [sheetOpen, payTo, notifOpen, settings]);

  const activePayments = useMemo(() => payments.filter((p) => p.status !== "disputed"), [payments]);
  const paymentsById = useMemo(() => Object.fromEntries(payments.map((p) => [p.id, p])), [payments]);
  const colorById = useMemo(() => Object.fromEntries(members.map((u) => [u.id, u.color])), [members]);
  const colorOf = (id) => colorById[id] || "oklch(0.62 0.14 260)";
  const names = useMemo(() => Object.fromEntries(members.map((u) => [u.id, u.name])), [members]);
  const unread = notifications.filter((n) => !n.read).length;

  const balances = useMemo(() => S.computeBalances(members, expenses, activePayments), [members, expenses, activePayments]);
  const paid = useMemo(() => S.totalPaid(members, expenses), [members, expenses]);
  const transfers = useMemo(
    () => (mode === "min" ? S.minimalTransfers(balances) : S.pairwiseTransfers(members, expenses, activePayments)),
    [mode, balances, members, expenses, activePayments]);
  const totalSpent = useMemo(() => expenses.reduce((a, e) => a + Math.round(e.amount * 100), 0), [expenses]);
  const allSettled = transfers.length === 0 && expenses.length > 0;
  const breakdown = useMemo(() => personalBreakdown(meMid, members, expenses, activePayments),
    [meMid, members, expenses, activePayments]);

  function openNew() { setEditing(null); setSheetOpen(true); }
  function openEdit(exp) { setEditing(exp); setSheetOpen(true); }
  async function onSave(exp) {
    try {
      const isEdit = expenses.some((e) => e.id === exp.id);
      const d = isEdit
        ? await api("/expenses/" + exp.id, { method: "PUT", body: exp })
        : await api("/groups/" + gid + "/expenses", { method: "POST", body: exp });
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
    try { applyState(await api("/groups/" + gid + "/payments", { method: "POST", body: { to: payTo.id, amount } })); setPayTo(null); }
    catch (ex) { alert(ex.message); }
  }
  async function openNotifs() {
    setNotifOpen(true);
    try { await api("/notifications/read", { method: "POST" }); setNotifications((ns) => ns.map((n) => ({ ...n, read: true }))); } catch (e) {}
  }
  async function confirmReceipt(pid) { try { applyState(await api("/payments/" + pid + "/confirm", { method: "POST" })); } catch (ex) { alert(ex.message); } }
  async function disputeReceipt(pid) { try { applyState(await api("/payments/" + pid + "/dispute", { method: "POST" })); } catch (ex) { alert(ex.message); } }
  async function saveSettings(v) {
    await api("/me/profile", { method: "PUT", body: v });
    const d = await api("/members/" + meMid, { method: "PUT", body: { name: v.name } });
    applyState(d); setSettings(false);
  }
  function copyTransfers() {
    const txt = transfers.map((tr) => `${names[tr.from]} → ${names[tr.to]} · ${S.fmt(tr.amount)}`).join("\n");
    try { navigator.clipboard.writeText(txt); } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  }
  function inviteLink() {
    const code = groupMeta.inviteCode;
    return inTelegram ? `https://t.me/${CFG.bot}/${CFG.app}?startapp=${code}` : location.origin + "/?join=" + code;
  }
  function shareInvite() {
    const link = inviteLink();
    // в Телеграме открываем нативный шеринг (выбор чата), иначе копируем ссылку
    if (inTelegram && TG.openTelegramLink) {
      const text = "Заходи в группу «" + groupMeta.name + "» — делим расходы в «Стажках»";
      TG.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text));
      return;
    }
    try { navigator.clipboard.writeText(link); } catch (e) {}
    setInvCopied(true); setTimeout(() => setInvCopied(false), 1600);
  }
  async function removeMember(m) {
    if (!(await confirmDialog("Убрать «" + m.name + "» из группы?"))) return;
    try { applyState(await api("/members/" + m.id, { method: "DELETE" })); } catch (ex) { alert(ex.message); }
  }
  async function leaveGroup() {
    const myBal = balances[meMid] || 0;
    let msg = "Выйти из группы «" + groupMeta.name + "»?";
    if (myBal > 50) msg += " Вам ещё должны " + S.fmt(myBal) + " — после выхода вы перестанете это видеть.";
    else if (myBal < -50) msg += " Вы ещё должны " + S.fmt(-myBal) + " — долг останется за вами.";
    if (!(await confirmDialog(msg))) return;
    try { await api("/groups/" + gid + "/leave", { method: "POST" }); onBack(); } catch (ex) { alert(ex.message); }
  }
  async function deleteGroup() {
    const outstanding = Object.values(balances).some((v) => Math.abs(v) >= 50);
    let msg = "Удалить группу «" + groupMeta.name + "» со всеми тратами? Отменить нельзя.";
    if (outstanding) msg += " Внимание: не все ещё рассчитались — есть непогашенные долги.";
    if (!(await confirmDialog(msg))) return;
    try { await api("/groups/" + gid, { method: "DELETE" }); onBack(); } catch (ex) { alert(ex.message); }
  }

  const grouped = useMemo(() => {
    let list = [...expenses];
    if (feedMine) list = list.filter((e) => expenseInvolves(e, meMid));
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const g = [];
    list.forEach((e) => {
      const key = fmtDate(e.date);
      let bucket = g.find((x) => x.key === key);
      if (!bucket) { bucket = { key, items: [] }; g.push(bucket); }
      bucket.items.push(e);
    });
    return g;
  }, [expenses, feedMine, meMid]);

  const PartCard = ({ m }) => {
    const b = balances[m.id] || 0;
    const pos = b > 50, neg = b < -50;
    return (
      <div className={"pcard" + (m.claimed ? "" : " ghost")}>
        <div className="av" style={{ background: m.color }}>{(m.name || "?")[0]}</div>
        <div className="pcard-info">
          <div className="pcard-name">{m.name}
            {m.isMe && <span style={{ color: "var(--text-3)", fontWeight: 500 }}> · Вы</span>}
            {!m.claimed && <span className="ghost-tag"><Ic.ghost /></span>}
          </div>
          {!m.claimed
            ? <div className="pcard-bal zero">ещё не в боте</div>
            : (pos || neg)
              ? <div className={"pcard-bal " + (pos ? "pos" : "neg")}><span className="num">{S.fmt(Math.abs(b))}</span></div>
              : <div className="pcard-bal zero">в расчёте</div>}
        </div>
        {isCreator && !m.isMe && (
          <button className="pcard-x" aria-label="Убрать" onClick={(e) => { e.stopPropagation(); removeMember(m); }}><Ic.close /></button>
        )}
      </div>
    );
  };

  const FeedItem = ({ e, idx }) => {
    const cat = window.CATEGORIES.find((c) => c.id === e.category) || window.CATEGORIES[0];
    const Icn = cat.icon, hue = cat.hue, mine = e.author === meMid;
    return (
      <div className="fitem" style={{ animationDelay: idx * 0.03 + "s" }}>
        <div className="fcat" style={{
          background: `color-mix(in oklch, oklch(0.6 0.14 ${hue}) 15%, var(--surface))`,
          color: `oklch(0.56 0.15 ${hue})` }}><Icn /></div>
        <div className="finfo">
          <div className="ftitle">{e.title}</div>
          <div className="fmeta">
            <span>платил {names[e.payer] || "?"}</span>
            <span className="sepd" /><span>{splitCount(e)} {pluralPeople(splitCount(e))}</span>
          </div>
        </div>
        <div className="fright">
          <div className="famt num">{S.fmt(Math.round(e.amount * 100))}</div>
          {mine && <button className="fact" onClick={() => openEdit(e)} aria-label="Изменить"><Ic.edit /></button>}
          {mine && <button className="fact del" onClick={() => onDelete(e.id)} aria-label="Удалить"><Ic.trash /></button>}
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
        <div className="empty settled"><div className="empty-emoji">🎉</div>
          <div className="empty-t">Все в расчёте</div>
          <div className="empty-d">Никто никому не должен. Красота.</div></div>
      ) : (
        <div className="tlist">
          {transfers.map((tr, i) => (
            <div className="trow" key={i} style={{ animationDelay: i * 0.04 + "s" }}>
              <div className="tparty">
                <div className="av" style={{ background: colorOf(tr.from) }}>{(names[tr.from] || "?")[0]}</div>{names[tr.from]}
              </div>
              <div className="tarrow"><Ic.arrow /></div>
              <div className="tparty">
                <div className="av" style={{ background: colorOf(tr.to) }}>{(names[tr.to] || "?")[0]}</div>{names[tr.to]}
              </div>
              <div className="tamt num">{S.fmt(tr.amount)}</div>
            </div>
          ))}
          <div className="tcopy-hint">
            {mode === "min" ? `Меньше всего переводов — ${transfers.length} ${pluralTransfer(transfers.length)}` : "Прямые долги по каждой паре"}
          </div>
        </div>
      )}
    </div>
  );

  const ParticipantsCard = (
    <div className="card card-pad">
      <div className="card-h"><span className="card-title">Участники</span>
        <button className="lnk-btn" onClick={shareInvite}>
          {invCopied ? <><Ic.check /> Скопировано</> : <><Ic.link /> Пригласить</>}
        </button>
      </div>
      <div className="pgrid">{members.map((m) => <PartCard key={m.id} m={m} />)}</div>
    </div>
  );

  const FeedCard = (
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
        )) : <div className="bd-empty" style={{ padding: "16px 4px" }}>{feedMine ? "Нет трат с вашим участием" : "Трат пока нет"}</div>}
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-top">
          <div className="brand">
            <button className="icon-btn" onClick={onBack} aria-label="К группам" style={{ width: 34, height: 34 }}><Ic.back /></button>
            <span className="brand-name">{groupMeta.name}</span>
          </div>
          <div className="hdr-actions">
            <button className="icon-btn ntf-btn" onClick={openNotifs} aria-label="Уведомления">
              <Ic.bell />{unread > 0 && <span className="ntf-badge">{unread > 9 ? "9+" : unread}</span>}
            </button>
            <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Настройки"><Ic.gear /></button>
            <button className="icon-btn" onClick={() => setDark((v) => !v)} aria-label="Тема">{dark ? <Ic.sun /> : <Ic.moon />}</button>
            <button className="btn-primary show-desktop" onClick={openNew}><Ic.plus /> Новая трата</button>
          </div>
        </div>
      </header>

      <div className="card card-pad" style={{ marginTop: "var(--gap-lg)" }}>
        <div className="psum">
          <div className="psum-cell"><div className="psum-lbl">Вам должны</div>
            <div className="psum-amt pos num">{S.fmt(breakdown.totalOwedToMe)}</div></div>
          <div className="psum-div" />
          <div className="psum-cell"><div className="psum-lbl">Вы должны</div>
            <div className="psum-amt neg num">{S.fmt(breakdown.totalIOwe)}</div></div>
        </div>
        <div className="bd">
          <BalanceSection title="Кто вам должен" total={breakdown.totalOwedToMe} dir="owed"
            entries={breakdown.owedToMe} colorOf={colorOf} emptyText="Пока никто вам не должен" />
          <BalanceSection title="Кому должны вы" total={breakdown.totalIOwe} dir="owe"
            entries={breakdown.iOwe} colorOf={colorOf} emptyText="Вы никому не должны" onPay={openPay} payInfo={payInfo} />
        </div>
        <div className="summary-sub" style={{ marginTop: 14 }}>
          <span className="chip">Потрачено вместе&nbsp;<span className="num">{S.fmt(totalSpent)}</span></span>
          <span className="chip">{members.length} {pluralPeople(members.length)}</span>
        </div>
      </div>

      {hasExpenses ? (
        <div className="grid">
          <div className="col">
            <div className="card card-pad">
              <div className="card-h"><span className="card-title">Граф расчётов · вы в центре</span></div>
              <SettlementGraph participants={members} balances={balances} paid={paid}
                transfers={transfers} names={names} hubId={meMid} />
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 8, fontSize: 12, color: "var(--text-2)", fontWeight: 600 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <i style={{ width: 9, height: 9, borderRadius: 9, background: "var(--pos)" }} />в плюсе</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <i style={{ width: 9, height: 9, borderRadius: 9, background: "var(--neg)" }} />в минусе</span>
              </div>
            </div>
            {TransfersCard}
          </div>
          <div className="col">
            {ParticipantsCard}
            {FeedCard}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: "var(--gap-lg)" }}>
          {ParticipantsCard}
          <div className="card card-pad">
            <div className="empty"><div className="empty-emoji">🧾</div>
              <div className="empty-t">Пока нет трат</div>
              <div className="empty-d">Добавьте первую трату — и мы сразу посчитаем, кто кому сколько должен.
                А чтобы позвать друзей — кнопка «Пригласить» выше.</div>
              <button className="btn-primary" style={{ marginTop: 14 }} onClick={openNew}><Ic.plus /> Добавить трату</button>
            </div>
          </div>
        </div>
      )}

      <button className="fab hide-desktop" onClick={openNew} aria-label="Новая трата"><Ic.plus /></button>

      <NewExpenseSheet open={sheetOpen} onClose={() => { setSheetOpen(false); setEditing(null); }}
        onSave={onSave} participants={members} editing={editing} defaultPayer={meMid} />
      <PaymentDialog open={!!payTo} peer={payTo || {}} defaultAmount={payTo ? payTo.amount : 0}
        onClose={() => setPayTo(null)} onConfirm={confirmPay} />
      <NotificationsPanel open={notifOpen} notifications={notifications} paymentsById={paymentsById}
        onClose={() => setNotifOpen(false)} onConfirm={confirmReceipt} onDispute={disputeReceipt} />
      <SettingsSheet open={settings} initial={{ name: (members.find((m) => m.isMe) || {}).name || meUser.name, payPhone: meUser.payPhone, payBank: meUser.payBank }}
        onClose={() => setSettings(false)} onSave={saveSettings}
        group={{ name: groupMeta.name, isCreator, onLeave: leaveGroup, onDelete: deleteGroup }} />
    </div>
  );
}

// ───────────────────────── корень ─────────────────────────
function Root() {
  const [dark, setDark] = useTheme();
  const [me, setMe] = useState(null);
  const [groups, setGroups] = useState([]);
  const [group, setGroup] = useState(null);
  const [ready, setReady] = useState(false);
  const [authErr, setAuthErr] = useState("");

  async function loadGroups() {
    const d = await api("/groups");
    setMe(d.user); setGroups(d.groups);
    return d;
  }
  function joinCode() {
    const q = new URLSearchParams(location.search).get("join");
    const sp = inTelegram && TG.initDataUnsafe ? TG.initDataUnsafe.start_param : null;
    return q || sp || null;
  }
  async function handleJoin() {
    const code = joinCode();
    if (!code) return;
    try {
      const d = await api("/groups/join", { method: "POST", body: { code } });
      setGroup(d);
    } catch (e) {}
    history.replaceState({}, "", location.pathname);
  }
  useEffect(() => {
    (async () => {
      try { CFG = await api("/config"); } catch (e) {}
      if (inTelegram) {
        try {
          TG.ready(); TG.expand();
          if (TG.colorScheme && localStorage.getItem("kkd-theme") === null) setDark(TG.colorScheme === "dark");
        } catch (e) {}
        try {
          const d = await api("/auth/telegram", { method: "POST", body: { initData: TG.initData } });
          tok.set(d.token); await loadGroups(); await handleJoin();
        } catch (e) { setAuthErr(String((e && e.message) || e)); }
      } else if (tok.get()) {
        try { await loadGroups(); await handleJoin(); } catch (e) { tok.set(null); }
      }
      setReady(true);
    })();
  }, []);

  async function openGroup(gid) { setGroup(await api("/groups/" + gid)); }
  async function afterAuth() { await loadGroups(); await handleJoin(); }
  function logout() { api("/auth/logout", { method: "POST" }).catch(() => {}); tok.set(null); setMe(null); setGroups([]); setGroup(null); }
  async function backToGroups() { setGroup(null); await loadGroups(); }

  if (!ready) return <div className="boot">Загрузка…</div>;
  if (!me) {
    if (CFG.telegram && !CFG.devLogin) {
      const diag = !TG ? "Telegram SDK не загрузился (window.Telegram пустой)"
        : !TG.initData ? "нет initData — открыто не как мини-аппа (initData пустой)"
        : (authErr ? ("вход отклонён сервером → " + authErr) : "проверка…");
      return <LockScreen bot={CFG.bot} diag={diag} />;
    }
    return <AuthScreen onAuthed={afterAuth} dark={dark} setDark={setDark} />;
  }
  if (!group) return <GroupsScreen me={me} groups={groups} dark={dark} setDark={setDark}
    onOpen={openGroup} onCreated={(d) => setGroup(d)} onLogout={logout} reload={loadGroups} />;
  return <GroupView key={group.group.id} initial={group} dark={dark} setDark={setDark} onBack={backToGroups} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
