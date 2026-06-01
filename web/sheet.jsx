// sheet.jsx — New / Edit expense bottom sheet. Exported to window.
const { useState: useStateS, useEffect: useEffectS, useMemo: useMemoS } = React;

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function parseAmount(s) {
  const n = parseFloat(String(s).replace(",", ".").replace(/\s/g, ""));
  return isNaN(n) ? 0 : n;
}

function NewExpenseSheet({ open, onClose, onSave, participants, editing, defaultPayer }) {
  const ids = participants.map((p) => p.id);
  const byId = Object.fromEntries(participants.map((p) => [p.id, p]));

  const [payer, setPayer] = useStateS(defaultPayer || ids[0]);
  const [amount, setAmount] = useStateS("");
  const [title, setTitle] = useStateS("");
  const [category, setCategory] = useStateS("food");
  const [date, setDate] = useStateS(todayISO());
  const [mode, setMode] = useStateS("equal");
  const [among, setAmong] = useStateS(new Set(ids));
  const [shares, setShares] = useStateS(Object.fromEntries(ids.map((i) => [i, 1])));
  const [exact, setExact] = useStateS(Object.fromEntries(ids.map((i) => [i, ""])));

  // (re)initialize when opened
  useEffectS(() => {
    if (!open) return;
    if (editing) {
      setPayer(editing.payer);
      setAmount(String(editing.amount));
      setTitle(editing.title);
      setCategory(editing.category);
      setDate(editing.date);
      const sp = editing.split || { mode: "equal", among: ids };
      setMode(sp.mode);
      setAmong(new Set(sp.among || ids));
      setShares({ ...Object.fromEntries(ids.map((i) => [i, 1])), ...(sp.shares || {}) });
      setExact({
        ...Object.fromEntries(ids.map((i) => [i, ""])),
        ...Object.fromEntries(Object.entries(sp.exact || {}).map(([k, v]) => [k, String(v)])),
      });
    } else {
      setPayer(defaultPayer || ids[0]);
      setAmount(""); setTitle(""); setCategory("food"); setDate(todayISO());
      setMode("equal"); setAmong(new Set(ids));
      setShares(Object.fromEntries(ids.map((i) => [i, 1])));
      setExact(Object.fromEntries(ids.map((i) => [i, ""])));
    }
  }, [open, editing]);

  const amt = parseAmount(amount);
  const amtK = Math.round(amt * 100);

  const equalCount = among.size || 1;
  const equalEach = Math.floor(amtK / equalCount);

  const totalShares = ids.reduce((a, i) => a + (Number(shares[i]) || 0), 0) || 1;
  const exactSumK = ids.reduce((a, i) => a + Math.round(parseAmount(exact[i]) * 100), 0);
  const exactRemK = amtK - exactSumK;

  const fmt = window.Settle.fmt;
  const CATS = window.CATEGORIES;
  const cat = CATS.find((c) => c.id === category) || CATS[0];

  function toggleAmong(id) {
    setAmong((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      if (n.size === 0) n.add(id);
      return n;
    });
  }
  function bumpShare(id, d) {
    setShares((p) => ({ ...p, [id]: Math.max(0, (Number(p[id]) || 0) + d) }));
  }

  const valid = amt > 0 && (mode !== "exact" || Math.abs(exactRemK) < 1) &&
    (mode !== "equal" || among.size > 0);

  function buildSplit() {
    if (mode === "equal") return { mode: "equal", among: [...among] };
    if (mode === "shares") {
      const s = {};
      ids.forEach((i) => { if ((Number(shares[i]) || 0) > 0) s[i] = Number(shares[i]); });
      return { mode: "shares", shares: s };
    }
    const e = {};
    ids.forEach((i) => { const v = parseAmount(exact[i]); if (v > 0) e[i] = v; });
    return { mode: "exact", exact: e };
  }

  function save() {
    if (!valid) return;
    onSave({
      id: editing ? editing.id : "e" + Date.now(),
      payer, amount: amt,
      title: title.trim() || cat.label,
      category, date, split: buildSplit(),
    });
  }

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-h">
          <b>{editing ? "Изменить трату" : "Новая трата"}</b>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"
            style={{ width: 34, height: 34, boxShadow: "none", background: "var(--surface-2)" }}>
            <Ic.close />
          </button>
        </div>

        <div className="sheet-body">
          {/* Amount */}
          <div className="field">
            <input className="input amount-input" inputMode="decimal" placeholder="0 ₽"
              value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!editing} />
          </div>

          {/* Payer */}
          <div className="field">
            <div className="flabel">Кто платил</div>
            <div className="payer-row">
              {participants.map((p) => (
                <div key={p.id} className={"payer-opt" + (payer === p.id ? " on" : "")}
                  onClick={() => setPayer(p.id)}>
                  <div className="av" style={{ background: p.color }}>{p.name[0]}</div>
                  <span>{p.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Title */}
          <div className="field">
            <div className="flabel">За что</div>
            <input className="input" placeholder="Например, ужин" value={title}
              onChange={(e) => setTitle(e.target.value)} />
          </div>

          {/* Category */}
          <div className="field">
            <div className="flabel">Категория</div>
            <div className="cat-row">
              {CATS.map((c) => {
                const Icn = c.icon;
                return (
                  <div key={c.id} className={"cat-opt" + (category === c.id ? " on" : "")}
                    onClick={() => setCategory(c.id)}>
                    <div className="ci" style={{ color: `oklch(0.6 0.13 ${c.hue})` }}><Icn /></div>
                    <span>{c.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Date */}
          <div className="field">
            <div className="flabel">Дата</div>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {/* Split */}
          <div className="field">
            <div className="flabel">Как делим</div>
            <div className="seg" style={{ display: "flex", width: "100%" }}>
              {[["equal", "Поровну"], ["shares", "Доли"], ["exact", "Точные суммы"]].map(([m, l]) => (
                <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{l}</button>
              ))}
            </div>

            <div className="split-list">
              {participants.map((p, i) => {
                const inEqual = among.has(p.id);
                let portionEl = null;
                if (mode === "equal") {
                  portionEl = (
                    <span className="split-portion">
                      {inEqual && amtK > 0 ? fmt(equalEach + (i < (amtK - equalEach * equalCount) && inEqual ? 1 : 0)) : "—"}
                    </span>
                  );
                } else if (mode === "shares") {
                  const sv = Number(shares[p.id]) || 0;
                  const pK = amtK > 0 ? Math.round((amtK * sv) / totalShares) : 0;
                  portionEl = (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="split-portion" style={{ minWidth: 64, textAlign: "right" }}>
                        {sv > 0 && amtK > 0 ? fmt(pK) : "—"}
                      </span>
                      <div className="stepper">
                        <button onClick={() => bumpShare(p.id, -1)}>−</button>
                        <span className="sv">{sv}</span>
                        <button onClick={() => bumpShare(p.id, 1)}>+</button>
                      </div>
                    </div>
                  );
                } else {
                  portionEl = (
                    <input className="mini-input" inputMode="decimal" placeholder="0"
                      value={exact[p.id]} onChange={(e) => setExact((pr) => ({ ...pr, [p.id]: e.target.value }))} />
                  );
                }
                const rowOn = mode === "equal" ? inEqual : true;
                return (
                  <div key={p.id} className={"split-row" + (rowOn ? " on" : " off")}
                    onClick={mode === "equal" ? () => toggleAmong(p.id) : undefined}
                    style={{ cursor: mode === "equal" ? "pointer" : "default" }}>
                    {mode === "equal" && (
                      <div className="split-check">{inEqual && <Ic.check />}</div>
                    )}
                    <div className="av" style={{ background: p.color, width: 30, height: 30, fontSize: 12.5 }}>
                      {p.name[0]}
                    </div>
                    <div className="split-name">{p.name}</div>
                    <div onClick={(e) => e.stopPropagation()}>{portionEl}</div>
                  </div>
                );
              })}
            </div>

            {mode === "exact" && (
              <div className={"remainder " + (Math.abs(exactRemK) < 1 ? "ok" : "warn")}>
                <span>{Math.abs(exactRemK) < 1 ? "Остаток" : exactRemK > 0 ? "Осталось распределить" : "Превышение"}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="num">{fmt(Math.abs(exactRemK))}</span>
                  {Math.abs(exactRemK) < 1 && <Ic.check />}
                </span>
              </div>
            )}
            {mode === "shares" && amtK > 0 && (
              <div className="remainder ok">
                <span>Всего долей: {totalShares}</span>
                <span className="num">{fmt(amtK)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="sheet-foot">
          <button className="btn-primary" disabled={!valid} onClick={save}
            style={{ opacity: valid ? 1 : 0.45, pointerEvents: valid ? "auto" : "none" }}>
            {editing ? "Сохранить" : "Добавить трату"}
            {amt > 0 && <span className="num" style={{ marginLeft: 4 }}>· {fmt(amtK)}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

window.NewExpenseSheet = NewExpenseSheet;
