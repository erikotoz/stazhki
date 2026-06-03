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

  // Порог «в расчёте» (копейки) — мелкие остатки округления не считаем долгом
  var EPS = 50;

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
    // net reciprocal
    const seen = new Set();
    const transfers = [];
    Object.keys(debt).forEach((key) => {
      if (seen.has(key)) return;
      const [a, b] = key.split(">");
      const rev = b + ">" + a;
      seen.add(key); seen.add(rev);
      const net = (debt[key] || 0) - (debt[rev] || 0);
      if (net > EPS) transfers.push({ from: a, to: b, amount: net });
      else if (net < -EPS) transfers.push({ from: b, to: a, amount: -net });
    });
    return transfers.sort((x, y) => y.amount - x.amount);
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

  window.Settle = {
    owedForExpense, computeBalances, totalPaid,
    minimalTransfers, pairwiseTransfers, fmt,
  };
})();
