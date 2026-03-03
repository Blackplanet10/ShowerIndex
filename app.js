// Shower Window Radar
// חישוב הסתברותי פשוט לפי היסטוריית אזעקות בקובץ JSON מקומי

const DATA_URL = "./data/alerts.json";
const SHOWER_MINUTES = 12;

const els = {
  area: document.getElementById("area"),
  riskScore: document.getElementById("riskScore"),
  riskBadge: document.getElementById("riskBadge"),
  pQuiet: document.getElementById("pQuiet"),
  pQuietHint: document.getElementById("pQuietHint"),
  sinceLast: document.getElementById("sinceLast"),
  lastTs: document.getElementById("lastTs"),
  refresh: document.getElementById("refresh"),
  updatedAt: document.getElementById("updatedAt")
};

let rawEvents = [];
let areas = [];
let byArea = new Map();

init();

async function init() {
  els.refresh.addEventListener("click", loadAndRender);
  els.area.addEventListener("change", renderForSelectedArea);
  await loadAndRender();
}

async function loadAndRender() {
  setLoading(true);
  try {
    rawEvents = await fetchJsonNoCache(DATA_URL);

    // ניקוי בסיסי
    rawEvents = rawEvents
      .filter(e => e && e.ts && e.area)
      .map(e => ({ ts: new Date(e.ts), area: String(e.area) }))
      .filter(e => !Number.isNaN(e.ts.getTime()));

    buildIndex();
    populateAreaSelect();
    renderForSelectedArea();
    els.updatedAt.textContent = `עודכן: ${formatDateTime(new Date())}`;
  } catch (err) {
    console.error(err);
    els.riskBadge.textContent = "שגיאה בטעינת נתונים";
    els.riskBadge.className = "badge bad";
  } finally {
    setLoading(false);
  }
}

async function fetchJsonNoCache(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.json();
}

function buildIndex() {
  byArea = new Map();
  for (const e of rawEvents) {
    if (!byArea.has(e.area)) byArea.set(e.area, []);
    byArea.get(e.area).push(e);
  }
  for (const [k, arr] of byArea.entries()) {
    arr.sort((a, b) => a.ts - b.ts);
    byArea.set(k, arr);
  }
  areas = Array.from(byArea.keys()).sort((a, b) => a.localeCompare(b, "he"));
}

function populateAreaSelect() {
  const current = els.area.value;
  els.area.innerHTML = "";
  for (const a of areas) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    els.area.appendChild(opt);
  }
  if (current && areas.includes(current)) els.area.value = current;
  if (!els.area.value && areas.length) els.area.value = areas[0];
}

function renderForSelectedArea() {
  const area = els.area.value;
  const events = byArea.get(area) || [];
  const now = new Date();

  const w24 = hoursAgo(24, now);
  const w7d = hoursAgo(24 * 7, now);
  const last24 = events.filter(e => e.ts >= w24 && e.ts <= now);
  const last7d = events.filter(e => e.ts >= w7d && e.ts <= now);

  const lastEvent = [...events].reverse().find(e => e.ts <= now) || null;
  const minutesSinceLast = lastEvent ? Math.max(0, (now - lastEvent.ts) / 60000) : Infinity;

  const rate24_per_hour = last24.length / 24;
  const rate7_per_hour = last7d.length / (24 * 7);

  // "בוסט שעה": כמה אזעקות היו בשבוע האחרון באותה שעה (0-23), מנורמל לשעה
  const hour = now.getHours();
  const hourCount7d = last7d.filter(e => e.ts.getHours() === hour).length;
  const hourRatePerHour = hourCount7d / 7; // ממוצע ליום באותה שעה

  // Risk score 0-100
  const n24 = normRate(rate24_per_hour, 0.0, 0.6);    // ~0..0.6 אזעקות לשעה זה סקאלה סבירה לדמו
  const n7  = normRate(rate7_per_hour,  0.0, 0.25);   // סקאלה נמוכה יותר לשבוע
  const timeFactor = Math.exp(-minutesSinceLast / 90); // יורד עם הזמן
  const hourBoost = clamp01(hourRatePerHour / 1.0) * 0.12; // עד 0.12

  const risk01 = clamp01(0.55 * n24 + 0.25 * n7 + 0.20 * timeFactor + hourBoost);
  const risk100 = Math.round(risk01 * 100);

  // הסתברות לשקט ל־N דקות לפי מודל פואסוני פשוט
  const lambda = 0.7 * rate24_per_hour + 0.3 * rate7_per_hour + 0.2 * hourRatePerHour;
  const pQuiet = Math.exp(-lambda * (SHOWER_MINUTES / 60));

  paintUI({ area, risk100, pQuiet, minutesSinceLast, lastEvent, last24Count: last24.length, last7dCount: last7d.length, lambda });
}

function paintUI({ risk100, pQuiet, minutesSinceLast, lastEvent, last24Count, last7dCount, lambda }) {
  els.riskScore.textContent = `${risk100}`;

  const badge = classifyRisk(risk100);
  els.riskBadge.textContent = badge.text;
  els.riskBadge.className = `badge ${badge.cls}`;

  const pPct = Math.round(pQuiet * 100);
  els.pQuiet.textContent = `${pPct}%`;
  els.pQuietHint.textContent = `מבוסס על קצב אירועים משוער. λ≈${lambda.toFixed(3)} לשעה`;

  if (!isFinite(minutesSinceLast)) {
    els.sinceLast.textContent = "אין נתונים";
    els.lastTs.textContent = "";
  } else {
    els.sinceLast.textContent = formatMinutes(minutesSinceLast);
    els.lastTs.textContent = lastEvent ? `אחרונה: ${formatDateTime(lastEvent.ts)}` : "";
  }

  // טיפ קצר לפי הסף
  if (pQuiet >= 0.8) {
    els.pQuietHint.textContent += " | חלון יחסית טוב ל־12 דקות";
  } else if (pQuiet >= 0.6) {
    els.pQuietHint.textContent += " | בינוני, עדיף לקצר ולהיות מוכן";
  } else {
    els.pQuietHint.textContent += " | סיכון גבוה יחסית כרגע";
  }
}

function classifyRisk(risk100) {
  if (risk100 <= 20) return { cls: "good", text: "נמוך" };
  if (risk100 <= 50) return { cls: "mid", text: "בינוני" };
  return { cls: "bad", text: "גבוה" };
}

function normRate(x, min, max) {
  // מנרמל לטווח 0..1
  return clamp01((x - min) / (max - min));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function hoursAgo(h, now) {
  return new Date(now.getTime() - h * 3600 * 1000);
}

function formatMinutes(m) {
  const mm = Math.floor(m);
  if (mm < 60) return `${mm} דקות`;
  const h = Math.floor(mm / 60);
  const r = mm % 60;
  return `${h} שעות ו־${r} דקות`;
}

function formatDateTime(d) {
  try {
    return new Intl.DateTimeFormat("he-IL", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function setLoading(isLoading) {
  els.refresh.disabled = isLoading;
  if (isLoading) {
    els.riskBadge.textContent = "טוען...";
    els.riskBadge.className = "badge mid";
  }
}