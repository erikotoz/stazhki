// icons.jsx — minimal line icons (category + UI). Exported to window.
const Ic = {};

function svg(children, props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em"
      style={{ display: "block" }} {...props}>{children}</svg>
  );
}

// ── Category icons ──
Ic.groceries = (p) => svg(<>
  <path d="M4 5h2l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h7.3a1.5 1.5 0 0 0 1.5-1.1L21 8H7" />
  <circle cx="10" cy="20" r="1" /><circle cx="18" cy="20" r="1" />
</>, p);
Ic.food = (p) => svg(<>
  <path d="M6 3v8a2 2 0 0 0 2 2h0v8M6 3v5M9 3v5M16 3c-1.2 0-2 1.6-2 4s.8 4 2 4v9" />
</>, p);
Ic.taxi = (p) => svg(<>
  <path d="M5 16v3M19 16v3" />
  <path d="M3 16v-3.2a2 2 0 0 1 .4-1.2L5.5 8.8A2 2 0 0 1 7.1 8h9.8a2 2 0 0 1 1.6.8l2.1 2.8a2 2 0 0 1 .4 1.2V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
  <path d="M3.5 12h17M9 5h6" /><circle cx="7.5" cy="13.5" r=".6" fill="currentColor" /><circle cx="16.5" cy="13.5" r=".6" fill="currentColor" />
</>, p);
Ic.bar = (p) => svg(<>
  <path d="M5 4h14l-7 8-7-8ZM12 12v6M8 21h8" />
</>, p);
Ic.home = (p) => svg(<>
  <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" />
</>, p);
Ic.travel = (p) => svg(<>
  <path d="M10 3.5 4.5 14H2l1.5 3 3 1.5L17 13l3.5-1.2a1.6 1.6 0 0 0 0-3L13 6 10 3.5Z" />
</>, p);
Ic.other = (p) => svg(<>
  <path d="M12 3 3 8v8l9 5 9-5V8l-9-5ZM3 8l9 5 9-5M12 13v8" />
</>, p);

// ── UI icons ──
Ic.plus = (p) => svg(<><path d="M12 5v14M5 12h14" /></>, p);
Ic.close = (p) => svg(<><path d="M6 6l12 12M18 6 6 18" /></>, p);
Ic.copy = (p) => svg(<>
  <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
</>, p);
Ic.check = (p) => svg(<><path d="M5 12.5 10 17l9-10" /></>, p);
Ic.arrow = (p) => svg(<><path d="M5 12h13M13 6l6 6-6 6" /></>, p);
Ic.sun = (p) => svg(<>
  <circle cx="12" cy="12" r="4" />
  <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
</>, p);
Ic.moon = (p) => svg(<><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></>, p);
Ic.edit = (p) => svg(<>
  <path d="M14 5.5 18.5 10 8 20.5l-4.5 1 1-4.5L14 5.5ZM13 7l4 4" />
</>, p);
Ic.trash = (p) => svg(<>
  <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
</>, p);
Ic.calendar = (p) => svg(<>
  <rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 9h16M8 3v4M16 3v4" />
</>, p);
Ic.users = (p) => svg(<>
  <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
  <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-2-4.3" />
</>, p);
Ic.scale = (p) => svg(<>
  <path d="M12 4v16M7 8h10M5 8l-2 5a3 3 0 0 0 6 0L7 8M17 8l-2 5a3 3 0 0 0 6 0l-2-5M8 20h8" />
</>, p);
Ic.logout = (p) => svg(<>
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
</>, p);
Ic.bell = (p) => svg(<>
  <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0" />
</>, p);
Ic.send = (p) => svg(<>
  <path d="M21 4 3 11l6 2 2 6 4-7M9 13l6-6" />
</>, p);
Ic.gear = (p) => svg(<>
  <circle cx="12" cy="12" r="3.2" />
  <path d="M12 2.5v2.4M12 19.1v2.4M4.2 7l2 1.2M17.8 15.8l2 1.2M19.8 7l-2 1.2M6.2 15.8l-2 1.2" />
</>, p);
Ic.back = (p) => svg(<><path d="M15 5l-7 7 7 7" /></>, p);
Ic.link = (p) => svg(<>
  <path d="M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5" />
</>, p);
Ic.ghost = (p) => svg(<>
  <path d="M5 21V9a7 7 0 0 1 14 0v12l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6Z" />
  <circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="10" r="1" fill="currentColor" stroke="none" />
</>, p);

const CATEGORIES = [
  { id: "food", label: "Еда", icon: Ic.food, hue: 28 },
  { id: "taxi", label: "Такси", icon: Ic.taxi, hue: 48 },
  { id: "bar", label: "Бар", icon: Ic.bar, hue: 320 },
  { id: "travel", label: "Путешествия", icon: Ic.travel, hue: 200 },
  { id: "other", label: "Другое", icon: Ic.other, hue: 220 },
];

Object.assign(window, { Ic, CATEGORIES });
