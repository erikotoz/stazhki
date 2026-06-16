/* compute.js — pure settlement logic. Works in integer kopecks to avoid float drift. */
(function () {
  // Sum of shares for one expense -> map of participantId -> owed kopecks
  function owedForExpense(exp, participantIds) {
    const out = {};
    const total = Math.round(exp.amount * 100);
    const split = exp.split || { mode: "equal", among: participantIds.slice() };

    if (split.mode === "equal") {
      const among = split.among && split.among.length ? split.among : participantIds.slice();
      const base = Math.floor(total / among.length);
      let rem = total - base * among.length; // distribute leftover kopecks
      among.forEach((id, i) => {
        out[id] = base + (i < rem ? 1 : 0);
      });
    } else if (split.mode === "shares") {
      const entries = Object.entries(split.shares || {}).filter(([, v]) => v > 0);
      const sum = entries.reduce((a, [, v]) => a + v, 0) || 1;
      let assigned = 0;
      entries.forEach(([id, v], i) => {
        const portion = i === entries.length - 1
          ? total - assigned
          : Math.round((total * v) / sum);
        out[id] = portion;
        assigned += portion;
      });
    } else if (split.mode === "exact") {
      Object.entries(split.exact || {}).forEach(([id, v]) => {
        out[id] = Math.round(v * 100);
      });
    }
    return out;
  }

  // balances: id -> kopecks (paid - owed). positive = creditor (owed to them)
  // payments — список переводов {from,to,amount}: перевод from→to уменьшает долг from перед to
  function computeBalances(participants, expenses, payments) {
    const ids = participants.map((p) => p.id);
    const bal = {};
    ids.forEach((id) => (bal[id] = 0));
    expenses.forEach((exp) => {
      bal[exp.payer] += Math.round(exp.amount * 100);
      const owed = owedForExpense(exp, ids);
      Object.entries(owed).forEach(([id, k]) => {
        if (bal[id] === undefined) bal[id] = 0;
        bal[id] -= k;
      });
    });
    (payments || []).forEach((p) => {
      const k = Math.round(p.amount * 100);
      if (bal[p.from] !== undefined) bal[p.from] += k; // отдал → должен меньше
      if (bal[p.to] !== undefined) bal[p.to] -= k;     // получил → ему должны меньше
    });
    return bal; // kopecks
  }

  function totalPaid(participants, expenses) {
    const paid = {};
    participants.forEach((p) => (paid[p.id] = 0));
    expenses.forEach((e) => (paid[e.payer] += Math.round(e.amount * 100)));
    return paid;
  }

  // Порог «в расчёте» (копейки) — суммы меньше 1 ₽ не считаем долгом.
  // Так копеечный «хвост» от округления перевода не висит вечным долгом.
  var EPS = 99;

  // Greedy minimal transfers from balances (kopecks)
  function minimalTransfers(balances) {
    const creditors = [];
    const debtors = [];
    Object.entries(balances).forEach(([id, k]) => {
      if (k > EPS) creditors.push({ id, k });
      else if (k < -EPS) debtors.push({ id, k: -k });
    });
    creditors.sort((a, b) => b.k - a.k);
    debtors.sort((a, b) => b.k - a.k);
    const transfers = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const c = creditors[ci], d = debtors[di];
      const amt = Math.min(c.k, d.k);
      if (amt > 0) transfers.push({ from: d.id, to: c.id, amount: amt });
      c.k -= amt; d.k -= amt;
      if (c.k === 0) ci++;
      if (d.k === 0) di++;
    }
    return transfers; // kopecks
  }

  // Pairwise net debts: directed debt per expense, then net reciprocal pairs
  function pairwiseTransfers(participants, expenses, payments) {
    const ids = participants.map((p) => p.id);
    const debt = {}; // key "from>to" -> kopecks (from owes to)
    expenses.forEach((exp) => {
      const owed = owedForExpense(exp, ids);
      Object.entries(owed).forEach(([id, k]) => {
        if (id === exp.payer) return;
        const key = id + ">" + exp.payer;
        debt[key] = (debt[key] || 0) + k;
      });
    });
    // переводы уменьшают долг from перед to
    (payments || []).forEach((p) => {
      const key = p.from + ">" + p.to;
      debt[key] = (debt[key] || 0) - Math.round(p.amount * 100);
    });
    // net reciprocal (схлопываем встречные долги в паре A↔B)
    const seen = new Set();
    let transfers = [];
    Object.keys(debt).forEach((key) => {
      if (seen.has(key)) return;
      const [a, b] = key.split(">");
      const rev = b + ">" + a;
      seen.add(key); seen.add(rev);
      const net = (debt[key] || 0) - (debt[rev] || 0);
      if (net > EPS) transfers.push({ from: a, to: b, amount: net });
      else if (net < -EPS) transfers.push({ from: b, to: a, amount: -net });
    });
    // Схлопываем циклы из 3+ участников (например А→Б→В→А по 150 — это «ничего»).
    // Взаимозачёт пар выше убирает только встречные долги (2 участника),
    // но не кольца длиннее. Вычитание минимального ребра кольца не меняет
    // ничей итоговый баланс — просто убирает бессмысленные переводы по кругу.
    transfers = cancelCycles(transfers);
    return transfers.sort((x, y) => y.amount - x.amount);
  }

  // Убрать направленные циклы из набора долгов, сохранив итоговые балансы.
  function cancelCycles(edges) {
    const amt = {}; // "from>to" -> копейки
    edges.forEach((e) => { const k = e.from + ">" + e.to; amt[k] = (amt[k] || 0) + e.amount; });
    function findCycle() {
      const adj = {};
      Object.keys(amt).forEach((k) => {
        if (amt[k] > 0) { const p = k.split(">"); (adj[p[0]] = adj[p[0]] || []).push(p[1]); }
      });
      const color = {}; // 1 = в текущем пути, 2 = пройдено
      const stack = [];
      let cyc = null;
      function dfs(u) {
        color[u] = 1; stack.push(u);
        const nbrs = adj[u] || [];
        for (let i = 0; i < nbrs.length && !cyc; i++) {
          const v = nbrs[i];
          if (color[v] === 1) { cyc = stack.slice(stack.indexOf(v)); return; }
          if (!color[v]) dfs(v);
        }
        if (!cyc) { stack.pop(); color[u] = 2; }
      }
      const nodes = Object.keys(adj);
      for (let i = 0; i < nodes.length && !cyc; i++) if (!color[nodes[i]]) dfs(nodes[i]);
      return cyc;
    }
    let guard = 0;
    while (guard++ < 1000) {
      const cyc = findCycle();
      if (!cyc) break;
      const keys = cyc.map((n, i) => n + ">" + cyc[(i + 1) % cyc.length]);
      const m = Math.min.apply(null, keys.map((k) => amt[k] || 0));
      keys.forEach((k) => { amt[k] -= m; });
    }
    return Object.keys(amt).filter((k) => amt[k] > EPS).map((k) => {
      const p = k.split(">");
      return { from: p[0], to: p[1], amount: amt[k] };
    });
  }

  // Format kopecks -> "1 200 ₽" (thin space thousands, no kopecks if whole)
  function fmt(kopecks, withSign) {
    const neg = kopecks < 0;
    let abs = Math.abs(kopecks);
    const rub = Math.floor(abs / 100);
    const kop = abs % 100;
    let s = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202F");
    if (kop) s += "," + String(kop).padStart(2, "0");
    s += "\u202F₽";
    if (withSign) s = (neg ? "−" : "+") + s;
    else if (neg) s = "−" + s;
    return s;
  }

  // Компактный формат для тесных мест: большие суммы -> «1,4 млн ₽», «2 млрд ₽».
  // Обычные суммы (< 1 млн ₽) показываем полностью.
  function fmtShort(kopecks) {
    var rub = Math.abs(kopecks) / 100;
    if (rub < 1e6) return fmt(kopecks);
    var neg = kopecks < 0;
    var units = [[1e12, "трлн"], [1e9, "млрд"], [1e6, "млн"]];
    for (var i = 0; i < units.length; i++) {
      if (rub >= units[i][0]) {
        var n = rub / units[i][0];
        var str = n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "").replace(".", ",");
        return (neg ? "−" : "") + str + " " + units[i][1] + " ₽";
      }
    }
    return fmt(kopecks);
  }

  window.Settle = {
    owedForExpense, computeBalances, totalPaid,
    minimalTransfers, pairwiseTransfers, fmt, fmtShort, EPS,
  };
})();
