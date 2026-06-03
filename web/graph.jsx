// graph.jsx — radial settlement graph (hub + orbit). Exported to window.
const { useState: useStateG } = React;

const VB = 340; // viewBox square

function layoutPositions(parts, hubId) {
  const cx = VB / 2, cy = VB / 2, R = 116;
  const others = parts.filter((p) => p.id !== hubId);
  const pos = {};
  pos[hubId] = { x: cx, y: cy };
  const n = others.length || 1;
  others.forEach((p, i) => {
    const ang = -Math.PI / 2 + i * ((2 * Math.PI) / n);
    pos[p.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  });
  return pos;
}

function nodeRadius(paid, maxPaid) {
  const minR = 19, maxR = 38;
  if (maxPaid <= 0) return minR;
  return minR + (paid / maxPaid) * (maxR - minR);
}

function quadPoint(s, c, e, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * s.x + 2 * mt * t * c.x + t * t * e.x,
    y: mt * mt * s.y + 2 * mt * t * c.y + t * t * e.y,
  };
}

function edgeGeom(pA, rA, pB, rB) {
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const px = -uy, py = ux;
  const bow = Math.min(26, dist * 0.16);
  const s = { x: pA.x + ux * rA, y: pA.y + uy * rA };
  const gap = rB + 8;
  const e = { x: pB.x - ux * gap, y: pB.y - uy * gap };
  const c = { x: (s.x + e.x) / 2 + px * bow, y: (s.y + e.y) / 2 + py * bow };
  const d = `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  // arrowhead direction from control toward end
  const adx = e.x - c.x, ady = e.y - c.y;
  const al = Math.hypot(adx, ady) || 1;
  const dux = adx / al, duy = ady / al;
  const size = 7.5;
  const ah = [
    [e.x, e.y],
    [e.x - dux * size - -duy * size * 0.62, e.y - duy * size - dux * size * 0.62],
    [e.x - dux * size + -duy * size * 0.62, e.y - duy * size + dux * size * 0.62],
  ].map((p) => p.join(",")).join(" ");
  const mid = quadPoint(s, c, e, 0.42);
  return { d, ah, mid };
}

function SettlementGraph({ participants, balances, paid, transfers, names, hubId: hubProp }) {
  const [sel, setSel] = useStateG(null);
  const maxPaid = Math.max(1, ...Object.values(paid));
  // hub (центр графа): залогиненный пользователь, если передан; иначе — кто больше всех платил
  const hubId = (hubProp && participants.some((p) => p.id === hubProp))
    ? hubProp
    : participants.reduce(
        (best, p) => (paid[p.id] > paid[best] ? p.id : best),
        participants[0].id
      );
  const pos = layoutPositions(participants, hubId);
  const rad = {};
  participants.forEach((p) => (rad[p.id] = nodeRadius(paid[p.id] || 0, maxPaid)));

  function balColor(id) {
    const b = balances[id] || 0;
    if (Math.abs(b) < 50) return "var(--neutral-node)";
    return b > 0 ? "var(--pos)" : "var(--neg)";
  }
  function balRing(id) {
    const b = balances[id] || 0;
    if (Math.abs(b) < 50) return "var(--neutral-node-ring)";
    return b > 0 ? "var(--pos-ring)" : "var(--neg-ring)";
  }

  const connected = (id) =>
    sel == null || transfers.some((t) => (t.from === id || t.to === id) &&
      (t.from === sel || t.to === sel)) || id === sel;
  const edgeActive = (t) => sel == null || t.from === sel || t.to === sel;

  const edges = transfers.map((t, i) => {
    const g = edgeGeom(pos[t.from], rad[t.from], pos[t.to], rad[t.to]);
    return { ...t, ...g, key: i };
  });

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="graph-svg" role="img"
        aria-label="Граф расчётов">
        <circle cx={VB / 2} cy={VB / 2} r="116" className="orbit" />
        {/* edges */}
        {edges.map((e) => (
          <g key={e.key} className={"edge" + (edgeActive(e) ? " on" : " off")}>
            <path d={e.d} className="edge-line" fill="none" />
            <polygon points={e.ah} className="edge-head" />
          </g>
        ))}
        {/* nodes */}
        {participants.map((p) => {
          const r = rad[p.id];
          const on = connected(p.id);
          const isSel = sel === p.id;
          return (
            <g key={p.id}
              className={"node" + (on ? " on" : " off") + (isSel ? " sel" : "")}
              transform={`translate(${pos[p.id].x},${pos[p.id].y})`}
              onClick={() => setSel(isSel ? null : p.id)}
              style={{ cursor: "pointer" }}>
              <circle r={r + 4} className="node-halo" style={{ fill: balRing(p.id) }} />
              <circle r={r} className="node-disc" style={{ fill: balColor(p.id) }} />
              <text className="node-init" textAnchor="middle" dy="0.34em"
                style={{ fontSize: Math.max(13, r * 0.62) }}>
                {names[p.id][0]}
              </text>
            </g>
          );
        })}
      </svg>
      {/* HTML overlay: name labels + amount pills, positioned by % */}
      <div className="graph-overlay">
        {participants.map((p) => {
          const r = rad[p.id];
          const yOff = ((pos[p.id].y + r + 13) / VB) * 100;
          const on = connected(p.id);
          return (
            <div key={p.id}
              className={"node-label" + (on ? "" : " dim")}
              style={{ left: (pos[p.id].x / VB) * 100 + "%", top: yOff + "%" }}>
              {names[p.id]}
            </div>
          );
        })}
        {edges.map((e) => (
          <div key={e.key}
            className={"edge-pill" + (edgeActive(e) ? "" : " dim")}
            style={{ left: (e.mid.x / VB) * 100 + "%", top: (e.mid.y / VB) * 100 + "%" }}>
            {window.Settle.fmtShort(e.amount)}
          </div>
        ))}
      </div>
    </div>
  );
}

window.SettlementGraph = SettlementGraph;
