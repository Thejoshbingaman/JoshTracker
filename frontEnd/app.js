import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from "./config.js";

// Connect to Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- SETTINGS ----------

// Airports that count as "home"
const HOME_AIRPORTS = ["BWI", "MDT", "PHL"];

// Airport code -> city name. Add more any time. Unknown codes just show the code.
const CITY = {
  BWI: "Baltimore", MDT: "Harrisburg", PHL: "Philadelphia", LAX: "Los Angeles",
  STL: "St. Louis", MDW: "Chicago", ORD: "Chicago", DEN: "Denver", DAL: "Dallas",
  HOU: "Houston", PHX: "Phoenix", LAS: "Las Vegas", MCO: "Orlando", TPA: "Tampa",
  BNA: "Nashville", ATL: "Atlanta", SAN: "San Diego", OAK: "Oakland", SJC: "San Jose",
  SMF: "Sacramento", AUS: "Austin", MSY: "New Orleans", FLL: "Fort Lauderdale",
  MCI: "Kansas City", SAT: "San Antonio", SEA: "Seattle",
  CHS: "Charleston", GSP: "Greenville", CAE: "Columbia", MYR: "Myrtle Beach", RDU: "Raleigh", CLT: "Charlotte",
  ISP: "Long Island", LGA: "New York", EWR: "Newark", BOS: "Boston", PIT: "Pittsburgh", CLE: "Cleveland", PDX: "Portland",
  SLC: "Salt Lake City", CLE: "Cleveland", CMH: "Columbus", PIT: "Pittsburgh",
  IND: "Indianapolis", MKE: "Milwaukee", RDU: "Raleigh", CLT: "Charlotte",
  BOS: "Boston", LGA: "New York", DCA: "Washington", IAD: "Washington",
};
const city = (code) => CITY[code] || code;

// Nicer words for AeroDataBox status codes
const STATUS_TEXT = {
  Expected: "On schedule", CheckIn: "Check-in", Boarding: "Boarding",
  GateClosed: "Gate closed", Departed: "Departed", EnRoute: "In the air",
  Approaching: "Landing soon", Arrived: "Landed", Delayed: "Delayed",
  Canceled: "Canceled", CanceledUncertain: "May be canceled", Diverted: "Diverted",
  Unknown: "Scheduled",
};

// Simple plane icon (points right)
const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" transform="rotate(90 12 12)" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`;

// ---------- PAGE ELEMENTS ----------

const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logoutButton = document.getElementById("logout");

let flights = [];      // flights from the database
let stays = [];        // hotel stays from the database
let timers = [];       // so we can stop the timers on sign out

// ---------- TIME HELPERS ----------

// Get the "-04:00" part from "2026-10-03 06:10-04:00", as minutes (-240)
function offsetMinutes(localString) {
  if (!localString) return 0;
  const off = localString.slice(-6);
  const sign = off[0] === "-" ? -1 : 1;
  return sign * (parseInt(off.slice(1, 3)) * 60 + parseInt(off.slice(4, 6)));
}

// Move a UTC time to an airport's local clock (returns a Date we read as UTC)
function toAirportClock(utcTime, localString) {
  return new Date(new Date(utcTime).getTime() + offsetMinutes(localString) * 60000);
}

// Every time on the page is shown in Eastern time (Arc's time zone)
const TIME_ZONE = "America/New_York";

// "Sat, Oct 3 · 6:10 AM" in Eastern time
function formatAt(utcTime, _localString, withDay = true) {
  if (!utcTime) return "—";
  const d = new Date(utcTime);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });
  if (!withDay) return time;
  return `${formatDay(utcTime)} · ${time}`;
}

// "Sat, Oct 3" in Eastern time
function formatDay(utcTime, _localString) {
  if (!utcTime) return "";
  return new Date(utcTime)
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TIME_ZONE });
}

// "2026-10-03" in Eastern time (used to compare days)
function dayKeyET(time) {
  return new Date(time).toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
}

// "2d 04:12:09" or "01:19:42"
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // Ticking clock style: 04:12:09, or 2d 04:12:09 when more than a day away
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

// "just now", "4 min ago", "2 hr ago"
function timeAgo(time) {
  const mins = Math.floor((Date.now() - new Date(time).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ago`;
}

// ---------- FLIGHT HELPERS ----------

// Where is this flight right now? upcoming / air / landed / canceled / diverted
function phaseOf(f) {
  const s = f.status || "";
  if (s === "Canceled" || s === "CanceledUncertain") return "canceled";
  if (s === "Diverted") return "diverted";
  if (s === "Arrived" || f.actualArrivalUtc) return "landed";
  if (["Departed", "EnRoute", "Approaching"].includes(s) || f.actualDepartureUtc) return "air";
  // No live data, but it should have landed over an hour ago
  if (Date.now() > new Date(f.arrivalUtc).getTime() + 3600000) return "landed";
  return "upcoming";
}

// Best known departure and arrival times
function departureTime(f) {
  return f.actualDepartureUtc || f.revisedDepartureUtc || f.departureUtc;
}
function arrivalTime(f) {
  // Predicted times are only trusted once the plane is in the air
  const predicted = phaseOf(f) === "air" ? f.predictedArrivalUtc : null;
  return f.actualArrivalUtc || f.revisedArrivalUtc || predicted || f.arrivalUtc;
}

// How far along the flight is, from 0 to 1
function progressOf(f) {
  const phase = phaseOf(f);
  if (phase === "landed") return 1;
  if (phase !== "air") return 0;
  const dep = new Date(departureTime(f)).getTime();
  const arr = new Date(arrivalTime(f)).getTime();
  return Math.min(1, Math.max(0, (Date.now() - dep) / (arr - dep)));
}

// Delay in minutes (0 if on time)
function delayMinutes(f) {
  if (!f.revisedDepartureUtc) return 0;
  const diff = (new Date(f.revisedDepartureUtc) - new Date(f.departureUtc)) / 60000;
  return diff >= 5 ? Math.round(diff) : 0;
}

// Is the departure today or tomorrow, in Eastern time?
function dayWord(f) {
  const depDay = dayKeyET(departureTime(f));
  const todayKey = dayKeyET(Date.now());
  const tomorrowKey = dayKeyET(Date.now() + 86400000);
  if (depDay === todayKey) return "today";
  if (depDay === tomorrowKey) return "tomorrow";
  return null;
}

// The flight to feature: the next one not finished, or one that landed in the last 2 hours
function pickHero(list) {
  return list.find((f) => {
    if (phaseOf(f) === "landed") {
      return Date.now() - new Date(arrivalTime(f)).getTime() < 2 * 3600000;
    }
    return true;
  }) || null;
}

// ---------- DRAWING THE PAGE ----------

// Small inline icons (no emoji)
const ICON = {
  plane: (deg = 0) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" transform="rotate(${deg} 12 12)" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`,
  home: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 11l9-7 9 7M5 10v10h14V10"/></svg>`,
  pin: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>`,
  clock: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>`,
  bed: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 6v13M3 15h18v4M21 15v-3a2 2 0 0 0-2-2h-8v5"/><circle cx="7" cy="12" r="1.8" fill="currentColor"/></svg>`,
  calendar: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M8 3v4M16 3v4"/></svg>`,
};

// The flight he's heading home on (from the featured one onward)
function homeFlightFrom(hero) {
  if (!hero) return null;
  return flights.slice(flights.indexOf(hero)).find(
    (f) => HOME_AIRPORTS.includes(f.destination) && ["upcoming", "air"].includes(phaseOf(f))
  ) || null;
}

// The hotel stay going on right now (null if none)
function currentStay() {
  const now = Date.now();
  return stays.find((s) => new Date(s.check_in).getTime() <= now && now < new Date(s.check_out).getTime()) || null;
}

// The stay he checked out of earlier today (he is usually still on the road)
function leftStayToday() {
  const now = Date.now(), today = dayKeyET(now);
  return stays.find((s) => dayKeyET(s.check_out) === today && now >= new Date(s.check_out).getTime()) || null;
}

// The hotel stay for this day ("2026-10-07"), from check-in day through check-out day
function stayOnNight(dayKey) {
  return stays.find((s) => dayKeyET(s.check_in) <= dayKey && dayKey <= dayKeyET(s.check_out)) || null;
}

// A hotel stay wins the headline unless a flight is in the air, just landed, or has a problem
function stayShowing(hero) {
  const stay = currentStay() || leftStayToday();
  if (!stay) return null;
  return !hero || phaseOf(hero) === "upcoming" ? stay : null;
}

function renderHeadline(hero) {
  let kicker = "", title = "", sub = "";
  const stay = stayShowing(hero);

  if (stay && Date.now() >= new Date(stay.check_out).getTime()) {
    kicker = "On the road";
    title = `Josh is heading home from ${stay.city}`;
    sub = `Checked out at ${formatAt(stay.check_out, null, false)}`;
  } else if (stay) {
    kicker = "Staying over";
    title = `Josh is in ${stay.city}`;
    sub = `${stay.hotel} · checks out ${formatAt(stay.check_out)}`;
  } else if (!hero) {
    const last = flights[flights.length - 1];
    if (last && !HOME_AIRPORTS.includes(last.destination)) {
      kicker = "On the ground";
      title = `Josh is in ${city(last.destination)}`;
      sub = "No more flights scheduled";
    } else {
      kicker = "No flights scheduled";
      title = "Josh is home";
    }
  } else {
    const phase = phaseOf(hero);
    const dest = city(hero.destination);
    if (phase === "air") {
      kicker = "In the air";
      title = `Josh is flying to ${dest}`;
    } else if (phase === "landed") {
      kicker = "Just landed";
      title = HOME_AIRPORTS.includes(hero.destination) ? "Josh is home" : `Josh landed in ${dest}`;
      sub = `Landed at ${formatAt(arrivalTime(hero), hero.arrivalLocal, false)}`;
    } else if (phase === "canceled") {
      kicker = "Heads up";
      title = `Flight ${hero.flightNumber} was canceled`;
      sub = "Josh will share a new plan soon";
    } else if (phase === "diverted") {
      kicker = "Heads up";
      title = `Flight ${hero.flightNumber} was diverted`;
      sub = "Josh will share an update soon";
    } else {
      const word = dayWord(hero);
      kicker = word ? `Flying ${word}` : "Next flight";
      title = HOME_AIRPORTS.includes(hero.origin) ? "Josh is home" : `Josh is in ${city(hero.origin)}`;
    }
  }

  document.getElementById("headline-kicker").textContent = kicker;
  document.getElementById("headline-title").textContent = title;
  const subEl = document.getElementById("headline-sub");
  subEl.textContent = sub;
  subEl.classList.toggle("hidden", !sub);
}

// Big ticking clock: time until takeoff, or until landing
function renderClock(hero) {
  const box = document.getElementById("clock");
  const phase = hero ? phaseOf(hero) : null;
  if (phase !== "upcoming" && phase !== "air") { box.classList.add("hidden"); return; }

  const now = Date.now();
  const target = phase === "air" ? arrivalTime(hero) : departureTime(hero);
  const text = formatDuration(new Date(target).getTime() - now);
  // Seconds in a softer color
  const cut = text.lastIndexOf(":");
  document.getElementById("clock-time").innerHTML =
    `${text.slice(0, cut)}<span class="clock-sec">${text.slice(cut)}</span>`;
  document.getElementById("clock-caption").textContent = phase === "air"
    ? `until he lands · ${formatAt(target, null, false)} your time`
    : `until takeoff to ${city(hero.destination)} · ${formatAt(target, null, false)}`;
  box.classList.remove("hidden");
}

// Miles between two [lat, lon] points
function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// Where Josh is right now, as [lat, lon] (null if unknown)
function joshPosition(hero) {
  const stay = stayShowing(hero);
  if (stay && stay.lat != null) return [stay.lat, stay.lon];
  if (!hero || hero.originLat == null || hero.destinationLat == null) return null;
  const phase = phaseOf(hero);
  const from = [hero.originLat, hero.originLon];
  const to = [hero.destinationLat, hero.destinationLon];
  if (phase === "air") {
    if (hero.lat != null && hero.lon != null) return [hero.lat, hero.lon];
    const pts = greatCirclePoints(from, to, 64);
    return pts[Math.round(progressOf(hero) * 64)];
  }
  if (phase === "landed") return to;
  return from;
}

// Where home is: the home airport he's flying back to (Baltimore if unknown)
const BWI = [39.1754, -76.6683];
function homePoint(hero) {
  const hf = homeFlightFrom(hero);
  if (hf && hf.destinationLat != null) return [hf.destinationLat, hf.destinationLon];
  if (hero && HOME_AIRPORTS.includes(hero.origin) && hero.originLat != null) return [hero.originLat, hero.originLon];
  return BWI;
}

function renderDistance(hero) {
  const el = document.getElementById("distance");
  const pos = joshPosition(hero);
  if (!pos) { el.classList.add("hidden"); return; }
  const miles = Math.round(milesBetween(pos, homePoint(hero)));
  if (miles < 30) { el.classList.add("hidden"); return; }
  el.innerHTML = `${ICON.pin}<span><strong>${miles.toLocaleString("en-US")}</strong> miles apart</span>`;
  el.classList.remove("hidden");
}

// "6:12 PM in Garden City": Josh's own clock, when it differs from Arc's (Eastern)
function joshClock(hero) {
  const now = new Date();
  const et = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });
  const fromZone = (tz) => now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const fromOffset = (localString) => toAirportClock(now.toISOString(), localString)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

  let time = null, place = "";
  const stay = stayShowing(hero);
  const phase = hero ? phaseOf(hero) : null;
  if (stay && stay.tz) {
    time = fromZone(stay.tz); place = stay.city;
  } else if (phase === "air" || phase === "landed") {
    time = fromOffset(hero.arrivalLocal); place = city(hero.destination);
  } else if (hero && !HOME_AIRPORTS.includes(hero.origin)) {
    time = fromOffset(hero.departureLocal); place = city(hero.origin);
  } else if (!hero) {
    const last = flights[flights.length - 1];
    if (last && !HOME_AIRPORTS.includes(last.destination)) { time = fromOffset(last.arrivalLocal); place = city(last.destination); }
  }
  return time && time !== et ? { time, place } : null;
}

function renderJoshClock(hero) {
  const el = document.getElementById("josh-clock");
  const c = joshClock(hero);
  if (!c) { el.classList.add("hidden"); return; }
  el.innerHTML = `${ICON.clock}<span><strong>${c.time}</strong> in ${escapeHtml(c.place)}</span>`;
  el.classList.remove("hidden");
}

// Small line at the bottom of the card: how fresh is the data?
function updatedLine(f, phase) {
  if (!f.lastCheckedUtc) {
    return `<p class="updated"><span class="fresh-dot dot-idle"></span>Live tracking starts 3 hr before departure</p>`;
  }
  const mins = (Date.now() - new Date(f.lastCheckedUtc).getTime()) / 60000;
  const stale = (phase === "air" || phase === "upcoming") && mins > 45;
  return `<p class="updated"><span class="fresh-dot ${stale ? "dot-stale" : "dot-fresh"}"></span>Live data · updated ${timeAgo(f.lastCheckedUtc)}</p>`;
}

function renderHero(hero) {
  const card = document.getElementById("flight-card");
  const el = document.getElementById("hero");
  if (!hero) { card.classList.add("hidden"); el.innerHTML = ""; return; }
  card.classList.remove("hidden");

  const phase = phaseOf(hero);
  const progress = progressOf(hero) * 100;
  const delay = delayMinutes(hero);

  // Delay / status tag over the map
  const chip = document.getElementById("delay-chip");
  const chipText =
    phase === "canceled" ? "Canceled" :
    phase === "diverted" ? "Diverted" :
    delay && phase !== "landed" ? `Delayed ${delay} min` : "";
  chip.textContent = chipText;
  chip.classList.toggle("hidden", !chipText);

  const mins = Math.round((new Date(arrivalTime(hero)) - new Date(departureTime(hero))) / 60000);
  const duration = mins > 0 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : "";
  const depLabel = phase === "upcoming" ? "Departs" : "Took off";
  const arrLabel = phase === "landed" ? "Landed" : "Lands";

  el.innerHTML = `
    <div class="fc">
      <div class="fc-route">
        <div><div class="code">${hero.origin}</div><div class="city">${city(hero.origin)}</div></div>
        <div class="fc-mid">${hero.flightNumber}${duration ? ` · ${duration}` : ""}</div>
        <div class="right"><div class="code">${hero.destination}</div><div class="city">${city(hero.destination)}</div></div>
      </div>

      <div class="bar">
        <div class="bar-fill" style="width:${progress}%"></div>
        <div class="bar-dot" style="left:${progress}%"></div>
      </div>

      <div class="fc-times">
        <div>
          <div class="t-label">${depLabel}</div>
          <div class="t-val">${formatAt(departureTime(hero), null, false)}</div>
          ${delay ? `<div class="t-sub was">${formatAt(hero.departureUtc, null, false)}</div>` : `<div class="t-sub">${formatDay(departureTime(hero))}</div>`}
        </div>
        <div class="right">
          <div class="t-label">${arrLabel}</div>
          <div class="t-val">${formatAt(arrivalTime(hero), null, false)}</div>
          <div class="t-sub">${hero.baggageBelt ? `Bags: belt ${hero.baggageBelt}` : formatDay(arrivalTime(hero))}</div>
        </div>
      </div>

      ${updatedLine(hero, phase)}
    </div>
  `;
}

function renderHomeCard(hero) {
  const el = document.getElementById("home-card");
  const hf = homeFlightFrom(hero);
  if (!hf) {
    // Driving trip: count down to hotel checkout instead
    const stay = currentStay();
    if (!stay) { el.innerHTML = ""; return; }
    const out = stay.check_out;
    const outDay = new Date(out).toLocaleDateString("en-US", { weekday: "short", timeZone: TIME_ZONE });
    el.innerHTML = `
      <article class="strip home">
        <span class="strip-icon">${ICON.bed}</span>
        <div class="strip-main">
          <span class="strip-label">Checks out in</span>
          <span class="strip-time">${formatDuration(new Date(out) - Date.now())}</span>
        </div>
        <span class="strip-side">${outDay}<br>${formatAt(out, null, false)}</span>
      </article>
    `;
    return;
  }

  const at = arrivalTime(hf);
  const day = new Date(at).toLocaleDateString("en-US", { weekday: "short", timeZone: TIME_ZONE });
  el.innerHTML = `
    <article class="strip home">
      <span class="strip-icon">${ICON.home}</span>
      <div class="strip-main">
        <span class="strip-label">Home in</span>
        <span class="strip-time">${formatDuration(new Date(at) - Date.now())}</span>
      </div>
      <span class="strip-side">${day}<br>${formatAt(at, null, false)}</span>
    </article>
  `;
}

// "This week": where Josh is each day, and any flights
function renderTimeline() {
  const el = document.getElementById("timeline");
  const title = document.getElementById("timeline-title");

  const active = flights.filter((f) => phaseOf(f) !== "landed" && phaseOf(f) !== "canceled");
  const upcomingStays = stays.filter((s) => dayKeyET(s.check_out) >= dayKeyET(Date.now()));
  if (active.length === 0 && upcomingStays.length === 0) {
    el.classList.add("hidden");
    title.classList.add("hidden");
    return;
  }

  const today = new Date();
  today.setHours(12, 0, 0, 0); // midday avoids daylight-saving edge cases

  let where = active.length ? active[0].origin : HOME_AIRPORTS[0];
  const rows = [];

  // How many days to show: 7 normally. When Josh is away, stretch through the day he gets home (21 max).
  const MAX_DAYS = 21;
  const dayIndex = (t) => {
    const k = dayKeyET(t);
    if (k < dayKeyET(today)) return -1;
    for (let i = 0; i < MAX_DAYS; i++) if (dayKeyET(today.getTime() + i * 86400000) === k) return i;
    return MAX_DAYS;
  };
  let days = 7;
  const reach = (t) => { days = Math.max(days, Math.min(MAX_DAYS, dayIndex(t) + 1)); };
  const homeFlightAfter = (t) => active.find((g) => departureTime(g) > t && HOME_AIRPORTS.includes(g.destination));
  for (let pass = 0; pass < 2; pass++) {
    // Away right now: show through the flight home
    if (!HOME_AIRPORTS.includes(where)) { const h = homeFlightAfter(new Date(0).toISOString()); if (h) reach(departureTime(h)); }
    // A trip that starts inside the window: show through its flight home
    for (const f of active) {
      if (dayIndex(departureTime(f)) < days && !HOME_AIRPORTS.includes(f.destination)) {
        const h = homeFlightAfter(departureTime(f));
        if (h) reach(departureTime(h));
      }
    }
    // A hotel stay that starts inside the window: show through checkout
    for (const st of stays) if (dayIndex(st.check_in) < days) reach(st.check_out);
  }
  title.textContent = days <= 7 ? "This week" : days <= 14 ? "Next 2 weeks" : "Until Josh is home";

  for (let i = 0; i < days; i++) {
    const day = new Date(today.getTime() + i * 86400000);
    const key = dayKeyET(day);
    const todays = active.filter((f) => dayKeyET(departureTime(f)) === key);

    const dow = i === 0 ? "Today" : day.toLocaleDateString("en-US", { weekday: "short", timeZone: TIME_ZONE });
    const num = day.toLocaleDateString("en-US", { day: "numeric", timeZone: TIME_ZONE });

    let body, icon = "";
    const stayNight = stayOnNight(key);
    if (todays.length > 0) {
      body = todays.map((f) => `
        <div class="tl-flight tl-tap" data-flight="${f.id}" role="button" tabindex="0">
          <span class="tl-route">${f.origin} → ${f.destination}</span>
          <span class="tl-time">${formatAt(departureTime(f), null, false)} · ${f.flightNumber}</span>
        </div>`).join("");
      icon = `<span class="tl-icon fly">${ICON.plane(f0dir(todays[0]))}</span>`;
      where = todays[todays.length - 1].destination;
    } else if (stayNight) {
      const out = key === dayKeyET(stayNight.check_out);
      body = `<span class="tl-where tl-tap" data-stay="${stayNight.id}" role="button" tabindex="0">In ${escapeHtml(stayNight.city)} · ${out ? "checkout" : "hotel"}</span>`;
      icon = `<span class="tl-icon">${ICON.bed}</span>`;
    } else if (HOME_AIRPORTS.includes(where)) {
      body = `<span class="tl-where home">Home</span>`;
      icon = `<span class="tl-icon">${ICON.home}</span>`;
    } else {
      body = `<span class="tl-where">In ${city(where)}</span>`;
    }

    rows.push(`
      <div class="tl-row${i === 0 ? " tl-today" : ""}">
        <div class="tl-day"><span class="tl-dow">${dow}</span><span class="tl-num">${num}</span></div>
        <div class="tl-body">${body}</div>
        ${icon}
      </div>`);
  }

  // Redraw only when something changed, so taps are not lost to the 1-second refresh
  const html = rows.join("");
  if (html !== lastTimelineHtml) { el.innerHTML = html; lastTimelineHtml = html; }
  el.classList.remove("hidden");
  title.classList.remove("hidden");
}
let lastTimelineHtml = "";

// Plane icon direction for the week list: east-bound points right, west-bound points left
function f0dir(f) {
  if (f.originLon != null && f.destinationLon != null) return f.destinationLon >= f.originLon ? 90 : -90;
  return 90;
}


// ---------- DETAIL SHEET ----------
// Tap a flight or hotel in "This week" to see more.

const sheet = document.createElement("div");
sheet.className = "sheet hidden";
sheet.innerHTML = `
  <div class="sheet-backdrop" data-close></div>
  <div class="sheet-panel" role="dialog" aria-modal="true">
    <div class="sheet-grip"></div>
    <div id="sheet-body"></div>
    <button type="button" class="ghost sheet-done" data-close>Done</button>
  </div>`;
document.body.appendChild(sheet);

function openSheet(html) {
  const body = document.getElementById("sheet-body");
  body.innerHTML = html;
  body.scrollTop = 0;
  sheet.classList.remove("hidden");
  document.body.classList.add("sheet-open");     // stop the page behind from scrolling
}
function closeSheet() { sheet.classList.add("hidden"); document.body.classList.remove("sheet-open"); }
sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

const sheetRow = (label, value) => value ? `<div class="sheet-row"><span>${label}</span><strong>${value}</strong></div>` : "";

// "8:10 AM local" when the airport is not on Eastern time
function airportLocal(utc, localString) {
  if (!localString) return "";
  const local = toAirportClock(utc, localString)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const et = formatAt(utc, null, false);
  return local === et ? "" : ` <span class="sheet-local">(${local} local)</span>`;
}

function flightSheet(f) {
  const phase = phaseOf(f);
  const mins = Math.round((new Date(arrivalTime(f)) - new Date(departureTime(f))) / 60000);
  const delay = delayMinutes(f);
  const status = STATUS_TEXT[f.status] || "Scheduled";
  return `
    <p class="sheet-kicker">${f.flightNumber} · ${formatDay(departureTime(f))}</p>
    <h2 class="sheet-title">${city(f.origin)} → ${city(f.destination)}</h2>
    <div class="sheet-rows">
      ${sheetRow("Status", delay && phase === "upcoming" ? `Delayed ${delay} min` : status)}
      ${sheetRow(phase === "upcoming" ? "Departs" : "Took off", formatAt(departureTime(f), null, false) + airportLocal(departureTime(f), f.departureLocal))}
      ${sheetRow(phase === "landed" ? "Landed" : "Lands", formatAt(arrivalTime(f), null, false) + airportLocal(arrivalTime(f), f.arrivalLocal))}
      ${sheetRow("Flight time", mins > 0 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : "")}
      ${sheetRow("Plane", f.aircraft ? escapeHtml(f.aircraft) : "")}
      ${sheetRow("Bags", f.baggageBelt ? `Belt ${escapeHtml(f.baggageBelt)}` : "")}
    </div>
    <p class="sheet-note">Times are Eastern (your time).</p>`;
}

function staySheet(s) {
  const nights = Math.max(1, Math.round(
    (new Date(dayKeyET(s.check_out)) - new Date(dayKeyET(s.check_in))) / 86400000));
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.hotel}, ${s.address || s.city}`)}`;
  return `
    <p class="sheet-kicker">Hotel · ${nights} night${nights === 1 ? "" : "s"}</p>
    <h2 class="sheet-title">${escapeHtml(s.hotel)}</h2>
    <div class="sheet-rows">
      ${sheetRow("Where", escapeHtml(`${s.city}, ${s.state || ""}`.replace(/, $/, "")))}
      ${sheetRow("Check-in", formatAt(s.check_in))}
      ${sheetRow("Check-out", formatAt(s.check_out))}
    </div>
    ${s.address ? `<a class="sheet-link" href="${maps}" target="_blank" rel="noopener">${escapeHtml(s.address)} ↗</a>` : ""}
    <p class="sheet-note">Check-in and check-out times are the usual 3 PM and 11 AM.</p>`;
}

function openDetail(target) {
  const fid = target.closest("[data-flight]")?.dataset.flight;
  const sid = target.closest("[data-stay]")?.dataset.stay;
  const f = fid && flights.find((x) => String(x.id) === fid);
  const s = sid && stays.find((x) => String(x.id) === sid);
  if (f) openSheet(flightSheet(f));
  else if (s) openSheet(staySheet(s));
}
const timelineEl = document.getElementById("timeline");
timelineEl.addEventListener("click", (e) => openDetail(e.target));
timelineEl.addEventListener("keydown", (e) => { if (e.key === "Enter") openDetail(e.target); });

// ---------- MAP ----------

let map = null;        // the Leaflet map (made once)
let mapLayers = null;  // lines and markers (redrawn on each update)

// Points along the curved (great-circle) path between two [lat, lon] points
function greatCirclePoints(a, b, steps = 64) {
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const [lat1, lon1] = [rad(a[0]), rad(a[1])];
  const [lat2, lon2] = [rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));
  if (d === 0) return [a, b];

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    points.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
  }
  return points;
}

// Compass direction (0 = north, 90 = east) from point a to point b
function bearing(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
            Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function airportIcon(code) {
  return L.divIcon({
    className: "map-airport",
    html: `<span class="map-dot"></span><span class="map-label">${code}</span>`,
    iconSize: [0, 0],
  });
}

// ---------- State borders ----------
let statesLayer = null;
let mapHero = null;

// Is a point inside a state's shape? (ray casting: count how many edges a line to the right crosses)
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inState(lat, lon, geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polys.some((poly) => inRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lon, lat, hole)));
}

// Faint borders everywhere; the two states of this flight glow red
function stateStyle(feature) {
  const h = mapHero;
  const lit = h && h.originLat != null &&
    (inState(h.originLat, h.originLon, feature.geometry) || inState(h.destinationLat, h.destinationLon, feature.geometry));
  return lit
    ? { color: "#ff4545", weight: 1.2, opacity: 0.55, fill: true, fillColor: "#ff4545", fillOpacity: 0.08 }
    : { color: "#ffffff", weight: 0.7, opacity: 0.16, fill: false };
}

function renderMap(hero) {
  const card = document.getElementById("map-card");

  // Hide the map if there is no flight or no airport locations yet
  if (!hero || hero.originLat == null || hero.destinationLat == null) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  // Make the map the first time only
  if (!map) {
    map = L.map("map", { zoomControl: false, scrollWheelZoom: false });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri",
      maxZoom: 12,
    }).addTo(map);
    // State borders sit under the route lines (their own layer, below the default overlay layer)
    map.createPane("states").style.zIndex = 350;
    fetch("us-states.json").then((r) => r.json()).then((geo) => {
      statesLayer = L.geoJSON(geo, { pane: "states", interactive: false, style: stateStyle }).addTo(map);
    }).catch(() => { /* no borders if the file can't load */ });
    mapLayers = L.layerGroup().addTo(map);
  }
  mapHero = hero;
  if (statesLayer) statesLayer.setStyle(stateStyle);
  map.invalidateSize();
  mapLayers.clearLayers();

  const from = [hero.originLat, hero.originLon];
  const to = [hero.destinationLat, hero.destinationLon];
  const phase = phaseOf(hero);
  const live = phase === "air" && hero.lat != null && hero.lon != null;

  // Where the plane is: its live position, or an estimate from the schedule
  const fullPath = greatCirclePoints(from, to);
  const estIndex = Math.round(progressOf(hero) * (fullPath.length - 1));
  const pos = live ? [hero.lat, hero.lon] : fullPath[estIndex];

  // Bright line = flown so far, dashed line = still to go.
  // Both lines pass through the plane, so it always sits on the route.
  let flown, toGo;
  if (phase === "air") {
    flown = greatCirclePoints(from, pos, 32);
    toGo = greatCirclePoints(pos, to, 32);
  } else if (phase === "landed") {
    flown = fullPath; toGo = [];
  } else {
    flown = []; toGo = fullPath;
  }
  if (toGo.length) L.polyline(toGo, { color: "#ffffff", opacity: 0.25, weight: 2, dashArray: "2 6" }).addTo(mapLayers);
  if (flown.length) L.polyline(flown, { color: "#ff4545", weight: 3 }).addTo(mapLayers);

  // Airports
  L.marker(from, { icon: airportIcon(hero.origin), interactive: false }).addTo(mapLayers);
  L.marker(to, { icon: airportIcon(hero.destination), interactive: false }).addTo(mapLayers);

  // Plane, pointing the way it's flying
  if (phase === "air") {
    const heading = hero.heading ?? (toGo.length > 1 ? bearing(toGo[0], toGo[1]) : bearing(from, to));
    L.marker(pos, {
      interactive: true,       // tappable for an easter egg
      keyboard: false,
      icon: L.divIcon({
        className: "map-plane",
        html: `<div style="transform: rotate(${heading - 90}deg)">${PLANE_SVG}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(mapLayers);
  }

  map.fitBounds(L.latLngBounds([from, to]), { padding: [36, 36] });
}

function render() {
  const hero = pickHero(flights);
  renderHeadline(hero);
  renderClock(hero);
  renderDistance(hero);
  renderJoshClock(hero);
  renderHero(hero);
  renderHomeCard(hero);
  renderVisit();
  renderTimeline();
}

// ---------- WHO IS SIGNED IN ----------

let myName = "";
const otherName = () => (myName.toLowerCase() === "josh" ? "Arc" : "Josh");

let isFamily = false;   // Mom: tracker only, no kisses, scoreboard, dates, or notes

async function loadMe() {
  // The saved session is on the phone already, so this needs no network (instant open)
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user;
  myName = user?.user_metadata?.name || "";
  isFamily = user?.app_metadata?.role === "family" || location.hash === "#demo-family"; // #demo-family = preview Mom's view
  document.body.classList.toggle("family", isFamily);
  myId = user?.id || null;
  document.getElementById("me-avatar").textContent = (myName || "?").slice(0, 1).toUpperCase();
  document.getElementById("me-hi").textContent = myName ? `Hi, ${myName}` : "Hi";
  document.getElementById("ping-title").textContent = `Send ${otherName()} something`;
  loadProfiles();
}

// ---------- PROFILE PHOTOS ----------
// Tap your circle (top left) to pick a photo. It is shrunk to a small square on the phone,
// saved in a private Supabase folder, and shown to the other person too.

let myId = null;
let profiles = [];            // [{ id, name, avatar_path, is_family, updated_at }]
const photoUrls = {};         // profile id -> temporary link to the photo

async function photoUrl(p) {
  if (!p?.avatar_path) return null;
  const key = `${p.id}:${p.updated_at}`;
  if (photoUrls[key]) return photoUrls[key];
  const { data } = await supabase.storage.from("avatars").createSignedUrl(p.avatar_path, 60 * 60 * 24);
  if (data?.signedUrl) photoUrls[key] = data.signedUrl;
  return photoUrls[key] || null;
}

// Fill a circle with a photo, or the first letter of the name
async function paintAvatar(el, p, name) {
  if (!el) return;
  const url = await photoUrl(p);
  el.innerHTML = url
    ? `<img src="${url}" alt="">`
    : escapeHtml((name || "?").slice(0, 1).toUpperCase());
}

// Josh's profile, and Arc's (the partner who is not family)
const joshProfile = () => profiles.find((p) => (p.name || "").toLowerCase() === "josh") || null;
const arcProfile = () => profiles.find((p) => (p.name || "").toLowerCase() !== "josh" && !p.is_family) || null;

async function loadProfiles() {
  if (myId) {
    // Make sure my own row exists (name and family flag kept current)
    await supabase.from("profiles").upsert({ id: myId, name: myName, is_family: isFamily }, { onConflict: "id", ignoreDuplicates: false });
  }
  const { data } = await supabase.from("profiles").select("*");
  profiles = data || [];
  paintAvatar(document.getElementById("me-avatar"), profiles.find((p) => p.id === myId), myName);
  paintScoreAvatars();
  if (myName.toLowerCase() === "josh") loadEggs();
}

function paintScoreAvatars() {
  document.querySelectorAll("[data-score-avatar]").forEach((el) => {
    const who = el.dataset.scoreAvatar;
    paintAvatar(el, who === "Josh" ? joshProfile() : arcProfile(), who);
  });
}

// Shrink any photo to a 320 x 320 square (center crop), as a JPEG
async function squarePhoto(file) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 320;
  canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 320, 320);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

const photoInput = document.createElement("input");
photoInput.type = "file";
photoInput.accept = "image/*";
photoInput.hidden = true;
document.body.appendChild(photoInput);

const meAvatar = document.getElementById("me-avatar");
meAvatar.setAttribute("role", "button");
meAvatar.setAttribute("tabindex", "0");
meAvatar.setAttribute("aria-label", "Change your photo");
meAvatar.removeAttribute("aria-hidden");
meAvatar.addEventListener("click", () => photoInput.click());
meAvatar.addEventListener("keydown", (e) => { if (e.key === "Enter") photoInput.click(); });

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  photoInput.value = "";
  if (!file || !myId) return;
  meAvatar.classList.add("busy");
  try {
    const blob = await squarePhoto(file);
    const path = `${myId}.jpg`;
    const { error } = await supabase.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
    if (error) throw error;
    await supabase.from("profiles").upsert({ id: myId, name: myName, is_family: isFamily, avatar_path: path, updated_at: new Date().toISOString() });
    await loadProfiles();
  } catch (err) {
    alert("Couldn't save the photo. Try again.\n" + (err.message || err));
  } finally {
    meAvatar.classList.remove("busy");
  }
});

// ---------- NEXT TIME TOGETHER ----------
// One shared row in the next_visit table. Either of you can set it.

let visit = null;        // { title, at }
let editingVisit = false;

async function loadVisit() {
  const { data } = await supabase.from("next_visit").select("*").eq("id", 1).maybeSingle();
  visit = data || null;
  renderVisit();
}

// "2026-10-10T19:30" for the date picker, in this phone's time
function toPickerValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let visitKey = "";       // what's drawn now, so we only redraw when it changes

function renderVisit() {
  const el = document.getElementById("visit-card");
  if (editingVisit) return; // don't wipe the form while typing

  const upcoming = visit?.at && new Date(visit.at).getTime() > Date.now() - 6 * 3600000;
  const key = upcoming ? `set|${visit.title}|${visit.at}` : "empty";

  // Same card as before: just tick the clock (keeps buttons tappable)
  if (key === visitKey && el.firstElementChild) {
    if (upcoming) {
      const left = new Date(visit.at).getTime() - Date.now();
      el.querySelector(".strip-time").textContent = left > 0 ? formatDuration(left) : "Today!";
    }
    return;
  }
  visitKey = key;

  if (!upcoming) {
    el.innerHTML = `
      <article class="strip visit empty">
        <span class="strip-icon">${ICON.calendar}</span>
        <div class="strip-main">
          <span class="strip-label">Next date</span>
          <span class="strip-note">Plan a date and count down to it</span>
        </div>
        <button type="button" class="chip-button" data-visit-edit>Set</button>
      </article>`;
  } else {
    const at = visit.at;
    const left = new Date(at).getTime() - Date.now();
    const day = new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TIME_ZONE });
    el.innerHTML = `
      <article class="strip visit">
        <span class="strip-icon">${ICON.calendar}</span>
        <div class="strip-main">
          <span class="strip-label">${escapeHtml(visit.title || "Next date")}</span>
          <span class="strip-time">${left > 0 ? formatDuration(left) : "Today!"}</span>
          <span class="strip-note">${day} · ${formatAt(at, null, false)}</span>
        </div>
        <button type="button" class="chip-button" data-visit-edit>Edit</button>
      </article>`;
  }
}

function openVisitEditor() {
  editingVisit = true;
  const el = document.getElementById("visit-card");
  el.innerHTML = `
    <form class="strip visit editing" id="visit-form">
      <span class="strip-label">Next date</span>
      <label class="field"><span>What</span>
        <input id="visit-title" type="text" maxlength="60" placeholder="Dinner date, weekend away…" value="${escapeHtml(visit?.title || "")}">
      </label>
      <label class="field"><span>When</span>
        <input id="visit-at" type="datetime-local" required value="${visit?.at ? toPickerValue(visit.at) : ""}">
      </label>
      <div class="visit-actions">
        <button type="button" class="ghost" id="visit-cancel">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>`;
  document.getElementById("visit-cancel").addEventListener("click", () => { editingVisit = false; visitKey = ""; renderVisit(); });
  document.getElementById("visit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("visit-title").value.trim();
    const atValue = document.getElementById("visit-at").value;
    if (!atValue) return;
    const { error } = await supabase.from("next_visit").upsert({ id: 1, title, at: new Date(atValue).toISOString() });
    editingVisit = false;
    visitKey = "";
    if (error) { alert("Could not save: " + error.message); }
    await loadVisit();
  });
}

document.getElementById("visit-card").addEventListener("click", (e) => {
  if (e.target.closest("[data-visit-edit]")) openVisitEditor();
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- THIS WEEK'S SCOREBOARD ----------

const SCORE_ICON = {
  kiss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#ff6f91" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6C12 6.1 13.6 5 15.6 5 19 5 21.1 8.5 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>',
  hug: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="9" fill="#ffb547"/><path d="M8 9.5q1.2-1.3 2.4 0M13.6 9.5q1.2-1.3 2.4 0M8.8 13q3.2 2.8 6.4 0" fill="none" stroke="#3a2205" stroke-width="1.6" stroke-linecap="round"/></svg>',
  punch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2.5h6.5a5.5 5.5 0 0 1 5.5 5.5v3.5a5.5 5.5 0 0 1-5.5 5.5H8.5A4.5 4.5 0 0 1 4 12.5V6.5a4 4 0 0 1 4-4z" fill="#ff4545"/><rect x="6.5" y="17.6" width="10.5" height="4" rx="1.3" fill="#ffb0b0"/></svg>',
};

async function loadScores() {
  const el = document.getElementById("score-card");
  // All-time totals. The database counts them, so this stays fast as the numbers grow.
  const count = (type, josh) => {
    let q = supabase.from("pings").select("id", { count: "exact", head: true }).eq("type", type);
    q = josh ? q.ilike("sender_name", "josh") : q.not("sender_name", "ilike", "josh");
    return q.then(({ count, error }) => { if (error) throw error; return count || 0; });
  };
  let people;
  try {
    const [ak, ah, ap, jk, jh, jp] = await Promise.all([
      count("kiss", false), count("hug", false), count("punch", false),
      count("kiss", true), count("hug", true), count("punch", true),
    ]);
    people = { Arc: { kiss: ak, hug: ah, punch: ap }, Josh: { kiss: jk, hug: jh, punch: jp } };
  } catch {
    el.classList.add("hidden"); return;
  }

  el.innerHTML = `
    <h2 class="section-title">All time</h2>
    <div class="card score">
    ${Object.entries(people).map(([name, c]) => `
      <div class="score-row">
        <span class="score-name"><span class="avatar small" data-score-avatar="${name}">${name.slice(0, 1)}</span>${escapeHtml(name)}</span>
        <span class="score-cell">${SCORE_ICON.kiss}${c.kiss}</span>
        <span class="score-cell">${SCORE_ICON.hug}${c.hug}</span>
        <span class="score-cell">${SCORE_ICON.punch}${c.punch}</span>
      </div>`).join("")}
    </div>
  `;
  el.classList.remove("hidden");
  paintScoreAvatars();
}

// ---------- LANDING CELEBRATION ----------
// Once per phone, when Josh's flight home has landed in the last 12 hours.

function confettiBurst() {
  const box = document.getElementById("confetti");
  box.innerHTML = "";
  const colors = ["#ff4545", "#ff6f91", "#ffb547", "#ffffff", "#ff9494"];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("span");
    p.className = "confetto";
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.8}s`;
    p.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    p.style.setProperty("--spin", `${Math.random() * 720 - 360}deg`);
    p.style.setProperty("--drift", `${Math.random() * 120 - 60}px`);
    box.appendChild(p);
  }
}

function maybeCelebrate(demo) {
  const now = Date.now();
  const f = flights.find((x) =>
    HOME_AIRPORTS.includes(x.destination) && phaseOf(x) === "landed" &&
    now - new Date(arrivalTime(x)).getTime() < 12 * 3600000
  );
  if (!f) return;
  const key = `celebrated-${f.flightNumber}-${f.date}`;
  if (!demo) {
    try { if (localStorage.getItem(key)) return; } catch { /* storage blocked: still celebrate */ }
  }
  document.getElementById("celebrate-sub").textContent =
    `Landed at ${f.destination} · ${formatAt(arrivalTime(f), null, false)}`;
  document.getElementById("celebrate").classList.remove("hidden");
  confettiBurst();
  document.getElementById("celebrate-close").onclick = () => {
    document.getElementById("celebrate").classList.add("hidden");
    if (!demo) { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } }
  };
}

// ---------- DATA ----------

// ---------- DEMO MODE ----------
// Add #demo to the address to see fake flights instead of real ones:
//   #demo         = in the air right now (BWI → LAX)
//   #demo-home    = just landed back home (shows the celebration)
//   #demo-before  = flight leaves in about 2 hours
//   #demo-landed  = just landed
//   #demo-hotel   = staying at a hotel on a driving trip
// Nothing is saved and no alerts are sent. Only you see it, on your own screen.

const DEMO_START = Date.now();

function demoStays(mode) {
  if (mode !== "hotel") return [];
  const day = 86400000;
  return [{
    id: "demo-stay", hotel: "DoubleTree by Hilton Hotel Reading", city: "Reading", state: "PA",
    lat: 40.3356, lon: -75.9269,
    check_in: new Date(DEMO_START - 0.8 * day).toISOString(),
    check_out: new Date(DEMO_START + 1.2 * day).toISOString(),
  }];
}

function demoFlights(mode) {
  if (mode === "hotel") return [];
  if (mode === "home") {
    const dep = new Date(DEMO_START - 330 * 60000).toISOString();
    const arr = new Date(DEMO_START - 25 * 60000).toISOString();
    return [{
      id: "demo-3", flightNumber: "WN2477", origin: "LAX", destination: "BWI", date: dep.slice(0, 10),
      originLat: 33.9425, originLon: -118.408, destinationLat: 39.1754, destinationLon: -76.6683,
      departureUtc: dep, departureLocal: dep.slice(0, 16).replace("T", " ") + "-07:00",
      arrivalUtc: arr, arrivalLocal: arr.slice(0, 16).replace("T", " ") + "-04:00",
      actualDepartureUtc: dep, actualArrivalUtc: arr, status: "Arrived", lastCheckedUtc: arr,
    }];
  }
  const min = 60000;
  const at = (offsetMin) => new Date(DEMO_START + offsetMin * min).toISOString();
  const local = (iso, offsetHours) => {
    const d = new Date(new Date(iso).getTime() + offsetHours * 3600000);
    const sign = offsetHours < 0 ? "-" : "+";
    const hh = String(Math.abs(offsetHours)).padStart(2, "0");
    return d.toISOString().slice(0, 16).replace("T", " ") + `${sign}${hh}:00`;
  };

  // Departure time relative to now for each mode
  const depOffset = mode === "before" ? 120 : mode === "landed" ? -340 : -120;
  const dep = at(depOffset);
  const arr = at(depOffset + 320);

  const outbound = {
    id: "demo-1", flightNumber: "WN1045", origin: "BWI", destination: "LAX",
    date: dep.slice(0, 10),
    originLat: 39.1754, originLon: -76.6683, destinationLat: 33.9425, destinationLon: -118.408,
    departureUtc: dep, departureLocal: local(dep, -4),
    arrivalUtc: arr, arrivalLocal: local(arr, -7),
    revisedDepartureUtc: at(depOffset + 20),      // a 20-minute delay, so the badge shows
    predictedArrivalUtc: at(depOffset + 335),
    status: "Expected",
    lastCheckedUtc: at(-4),
  };
  if (mode === "air" || mode === "landed") {
    outbound.actualDepartureUtc = at(depOffset + 20);
    outbound.status = "EnRoute";
  }
  if (mode === "landed") {
    outbound.actualArrivalUtc = at(depOffset + 330);
    outbound.status = "Arrived";
  }

  const back = at(3 * 1440 + 600);
  const backArr = at(3 * 1440 + 600 + 290);
  const inbound = {
    id: "demo-2", flightNumber: "WN2477", origin: "LAX", destination: "BWI",
    date: back.slice(0, 10),
    originLat: 33.9425, originLon: -118.408, destinationLat: 39.1754, destinationLon: -76.6683,
    departureUtc: back, departureLocal: local(back, -7),
    arrivalUtc: backArr, arrivalLocal: local(backArr, -4),
    status: "Expected",
  };
  return [outbound, inbound];
}

function demoMode() {
  const h = location.hash.replace("#", "");
  if (h === "demo") return "air";
  if (h === "demo-before") return "before";
  if (h === "demo-landed") return "landed";
  if (h === "demo-home") return "home";
  if (h === "demo-hotel") return "hotel";
  return null;
}

async function loadFlights() {
  const mode = demoMode();
  document.body.classList.toggle("demo", !!mode);
  if (mode) {
    flights = demoFlights(mode);
    stays = demoStays(mode);
    render();
    renderMap(pickHero(flights));
    if (mode === "home") maybeCelebrate(true);
    return;
  }

  const { data, error } = await supabase
    .from("flights")
    .select("*")
    .order("departureUtc", { ascending: true });

  if (error) {
    document.getElementById("hero").innerHTML = `<p class="error">${error.message}</p>`;
    return;
  }
  flights = data;
  const since = new Date(Date.now() - 86400000).toISOString();
  const stayRes = await supabase.from("stays").select("*").gt("check_out", since).order("check_in");
  stays = stayRes.error ? [] : stayRes.data; // no stays table yet = no stays
  saveSnapshot();
  render();
  renderMap(pickHero(flights)); // the map only redraws when new data comes in
  maybeCelebrate(false);
}

// ---------- COUPON WALLET ----------
// Unlocked coupons live on a card under the scoreboard. Arc taps one to use it; Josh gets an alert.

let coupons = [];
async function loadCoupons() {
  if (isFamily) return;
  if (location.hash === "#demo-coupons") {
    coupons = [
      { id: 1, type: "kiss", count: 50, coupon: "Nails on me", coupon_details: "Good for one nail appointment of your choice. Josh pays.", redeemed_at: null },
      { id: 4, type: "hug", count: 50, coupon: "Movie night, your pick", coupon_details: "Snacks included. No complaining.", redeemed_at: new Date().toISOString() },
    ];
  } else {
    const { data, error } = await supabase.from("milestones")
      .select("id, type, count, coupon, coupon_details, redeemed_at")
      .not("coupon", "is", null).order("unlocked_at");
    coupons = error ? [] : data;
  }
  renderCoupons();
}

function renderCoupons() {
  const el = document.getElementById("coupon-card");
  if (!coupons.length) { el.innerHTML = ""; return; }
  const open = coupons.filter((c) => !c.redeemed_at).length;
  const mine = myName.toLowerCase() !== "josh";
  el.innerHTML = `
    <h2 class="section-title coupons-title"><span>${mine ? "Your coupons" : `${otherName()}'s coupons`}</span><span>${open} to use</span></h2>
    <div class="card coupons">
      ${coupons.map((c) => `
        <button type="button" class="coupon-row${c.redeemed_at ? " used" : ""}" data-coupon="${c.id}">
          <span class="coupon-dot"></span>
          <span class="coupon-name">${escapeHtml(c.coupon)}</span>
          <span class="coupon-state">${c.redeemed_at ? "Used" : "Ready"}</span>
        </button>`).join("")}
    </div>`;
}

document.getElementById("coupon-card").addEventListener("click", (e) => {
  const id = e.target.closest("[data-coupon]")?.dataset.coupon;
  const c = coupons.find((x) => String(x.id) === id);
  if (!c) return;
  // Only Arc can cash in. In the #demo-coupons preview, anyone can try it (nothing is saved).
  const canUse = !c.redeemed_at && (myName.toLowerCase() !== "josh" || location.hash === "#demo-coupons");
  openSheet(`
    ${ticketHtml(c)}
    ${canUse ? `<button type="button" class="coupon-use" data-use="${c.id}">Use it now</button>
      <p class="sheet-note">Josh gets an alert that you're cashing it in.</p>` : ""}`);
  const btn = document.querySelector("[data-use]");
  if (!btn) return;
  let armed = false;
  btn.addEventListener("click", async () => {
    if (!armed) { armed = true; btn.textContent = "Tap again to confirm"; btn.classList.add("armed"); return; }
    btn.disabled = true; btn.textContent = "Cashing in…";
    if (location.hash === "#demo-coupons") { c.redeemed_at = new Date().toISOString(); }
    else {
      const { data, error } = await supabase.functions.invoke("send-kiss", { body: { redeem: c.id } });
      if (error || !data?.ok) { btn.disabled = false; btn.textContent = "Didn't work. Try again."; armed = false; return; }
      c.redeemed_at = new Date().toISOString();
    }
    document.getElementById("sheet-body").innerHTML = `${ticketHtml(c)}<p class="sheet-note">Josh got the alert. Enjoy.</p>`;
    renderCoupons();
  });
});

// ---------- APP ICON BADGE ----------
// A new kiss/hug/punch puts a number on the app icon (set by sw.js). Opening the app clears it.
function clearBadge() {
  try { navigator.clearAppBadge?.(); } catch { /* not supported */ }
  // Also clear ping alerts still sitting in the notification list
  navigator.serviceWorker?.ready.then((reg) => reg.getNotifications())
    .then((list) => list.forEach((n) => { if ((n.tag || "").startsWith("ping-")) n.close(); }))
    .catch(() => {});
}

// ---------- INSTANT OPEN ----------
// The last data is saved on the phone, so the app shows it at once,
// then swaps in fresh data a moment later (or keeps it if there is no signal).
const SNAPSHOT_KEY = "jt-snapshot-v1";
function saveSnapshot() {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ flights, stays, at: Date.now() })); } catch { /* storage off */ }
}
function showSnapshot() {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    if (!snap || demoMode()) return false;
    flights = snap.flights || [];
    stays = snap.stays || [];
    render();
    return true;
  } catch { return false; }
}

// ---------- REALTIME ----------
// Supabase tells the open app the moment a row changes, so there is no wait for the next refresh.
let channel = null;
function debounce(fn, ms = 400) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
function startRealtime() {
  stopRealtime();
  const flightsChanged = debounce(() => { if (!demoMode()) loadFlights(); });
  channel = supabase.channel("joshtracker")
    .on("postgres_changes", { event: "*", schema: "public", table: "flights" }, flightsChanged)
    .on("postgres_changes", { event: "*", schema: "public", table: "stays" }, flightsChanged);
  if (!isFamily) {
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "pings" }, debounce(loadScores))
      .on("postgres_changes", { event: "*", schema: "public", table: "next_visit" }, debounce(loadVisit))
      .on("postgres_changes", { event: "*", schema: "public", table: "milestones" }, debounce(() => { checkMilestones(); loadCoupons(); }));
  }
  channel.subscribe();
}
function stopRealtime() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
}

// ---------- MILESTONE NOTES ----------
// When Arc sends her 50th or 100th kiss, hug, or punch, Josh's note for it pops up.

const MILESTONE_WORD = { kiss: ["kiss", "kisses"], hug: ["hug", "hugs"], punch: ["punch", "punches"] };
const milestoneEl = document.createElement("div");
milestoneEl.className = "milestone hidden";
milestoneEl.setAttribute("role", "dialog");
milestoneEl.setAttribute("aria-modal", "true");
document.body.appendChild(milestoneEl);
let milestoneShowing = null;

function showMilestone(m) {
  if (!m || milestoneShowing) return;
  milestoneShowing = m;
  const icon = document.querySelector(`.ping-${m.type} .ping-orb svg`)?.outerHTML || "";
  const [one, many] = MILESTONE_WORD[m.type] || ["", ""];
  const floaters = Array.from({ length: 26 }, (_, i) =>
    `<span class="m-float" style="left:${(i * 37) % 100}%;animation-delay:${(i % 9) * 0.35}s;animation-duration:${4 + (i % 5)}s;--s:${0.6 + (i % 4) * 0.25}">${icon}</span>`).join("");
  milestoneEl.innerHTML = `
    <div class="m-floaters" aria-hidden="true">${floaters}</div>
    <div class="m-inner">
      <div class="m-badge"><span class="m-icon">${icon}</span></div>
      <p class="m-kicker">Milestone unlocked</p>
      <h1 class="m-count"><span class="m-num" data-to="${m.count}">0</span> ${m.count === 1 ? one : many}</h1>
      <div class="m-card">
        <p class="m-note">${escapeHtml(m.note).replace(/\n/g, "<br>")}</p>
        <p class="m-sign">Josh</p>
      </div>
      ${m.coupon ? `<div class="m-ticket-wrap">${ticketHtml(m)}</div>` : ""}
      <button type="button" class="m-close">Here's to the next ${m.count}!</button>
    </div>`;
  milestoneEl.classList.remove("hidden");
  // Count up 0 → 50
  const num = milestoneEl.querySelector(".m-num");
  const to = m.count, start = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - start) / 1400);
    num.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 120]);
  milestoneEl.querySelector(".m-close").addEventListener("click", closeMilestone);
}

// A coupon, drawn as a ticket with notched sides
function ticketHtml(c, opts = {}) {
  const used = c.redeemed_at;
  return `
    <div class="ticket${used ? " used" : ""}">
      <div class="ticket-top">
        <span class="ticket-kicker">Coupon · ${c.count} ${(MILESTONE_WORD[c.type] || ["", ""])[1]}</span>
        <span class="ticket-title">${escapeHtml(c.coupon)}</span>
        ${c.coupon_details ? `<span class="ticket-details">${escapeHtml(c.coupon_details)}</span>` : ""}
      </div>
      <div class="ticket-bottom">
        <span>${used ? `Used ${formatDay(c.redeemed_at)}` : "Show this to Josh"}</span>
        <span class="ticket-no">No. ${String(c.id || 0).padStart(3, "0")}</span>
      </div>
      ${used ? `<span class="ticket-stamp">Used</span>` : ""}
    </div>`;
}

async function closeMilestone() {
  const m = milestoneShowing;
  milestoneEl.classList.add("hidden");
  milestoneShowing = null;
  if (m?.id) await supabase.from("milestones").update({ seen_at: new Date().toISOString() }).eq("id", m.id);
  checkMilestones(); // another one waiting?
  loadCoupons();
}

// Preview the screen with a sample note: #demo-milestone-kiss, -hug, or -punch (add -100 for the 100th)
function previewMilestone() {
  const m = location.hash.match(/^#demo-milestone-(kiss|hug|punch)(-100)?$/);
  if (!m) return;
  showMilestone({ type: m[1], count: m[2] ? 100 : 50,
    note: "This is a preview. Your real note for this milestone shows here, word for word.\n\nNew lines show like this.",
    coupon: "Nails on me", coupon_details: "Good for one nail appointment of your choice. Josh pays." });
}

// Any unlocked note she has not seen yet (e.g. unlocked on another phone)? Only Arc's app shows them.
async function checkMilestones() {
  if (isFamily || myName.toLowerCase() === "josh" || milestoneShowing) return;
  const { data } = await supabase.from("milestones").select("id, type, count, title, note, coupon, coupon_details")
    .is("seen_at", null).order("unlocked_at").limit(1);
  if (data?.[0]) showMilestone(data[0]);
}

// ---------- ALERTS (push notifications) ----------

const alertsCard = document.getElementById("alerts-card");
const alertsText = document.getElementById("alerts-text");
const alertsButton = document.getElementById("alerts-button");

// Start the background service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

// The VAPID key is text; the browser wants raw bytes
function keyToBytes(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// Save this phone's address so the server can reach it
async function saveSubscription(subscription) {
  const json = subscription.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent,
    },
    { onConflict: "endpoint" }
  );
  return error;
}

// Show or hide the "Turn on alerts" card
async function refreshAlertsCard() {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  if (!supported) {
    if (isIPhone && !installed) {
      alertsText.textContent = "To get alerts: tap Share, then Add to Home Screen. Then open JoshTracker from your home screen.";
      alertsButton.classList.add("hidden");
      alertsCard.classList.remove("hidden");
    } else {
      alertsCard.classList.add("hidden");
    }
    return;
  }

  if (Notification.permission === "denied") {
    alertsText.textContent = "Alerts are blocked. Turn them on for this site in your phone's settings.";
    alertsButton.classList.add("hidden");
    alertsCard.classList.remove("hidden");
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && Notification.permission === "granted") {
    alertsCard.classList.add("hidden"); // already on
    saveSubscription(subscription);     // re-save each time, in case the server lost it
    return;
  }

  alertsText.textContent = "Get a ping when Josh boards, lands, or is delayed, and when he sends you something.";
  alertsButton.classList.remove("hidden");
  alertsCard.classList.remove("hidden");
}

// "Turn on" was tapped
alertsButton.addEventListener("click", async () => {
  alertsButton.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY),
    });

    const error = await saveSubscription(subscription);
    if (error) alert("Could not save alerts: " + error.message);
  } catch (err) {
    alert("Could not turn on alerts: " + err.message);
  } finally {
    alertsButton.disabled = false;
    refreshAlertsCard();
  }
});

// ---------- KISS / HUG / PUNCH ----------

const pingButtons = [...document.querySelectorAll(".ping")];
const pingStatus = document.getElementById("ping-status");
const PING_DONE = { kiss: "Kiss sent ♥", hug: "Hug sent", punch: "Punch landed. Ouch." };

// Kiss: little hearts float up from the button
function heartBurst(button) {
  const box = button.getBoundingClientRect();
  for (let i = 0; i < 12; i++) {
    const h = document.createElement("span");
    h.className = "float-heart";
    h.textContent = "♥";
    h.style.left = `${box.left + box.width / 2 + (Math.random() - 0.5) * box.width}px`;
    h.style.top = `${box.top + window.scrollY}px`;
    h.style.animationDelay = `${Math.random() * 0.3}s`;
    h.style.fontSize = `${14 + Math.random() * 16}px`;
    document.body.appendChild(h);
    setTimeout(() => h.remove(), 1800);
  }
}

// Hug: two glowing arms sweep in from the sides, wrap around a heart, squeeze, and fade
function hugEffect() {
  const overlay = document.createElement("div");
  overlay.className = "hug-overlay";
  overlay.innerHTML = `
    <div class="hug-glow"></div>
    <div class="hug-arm left"></div>
    <div class="hug-arm right"></div>
    <div class="hug-heart">♥</div>
    <div class="hug-word">Hug</div>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 1900);
  document.body.classList.add("squeeze");
  setTimeout(() => document.body.classList.remove("squeeze"), 1300);
  if (navigator.vibrate) navigator.vibrate([40, 80, 40]);
}

// Punch: the screen shakes and a "POW!" pops out
function punchEffect(button) {
  const box = button.getBoundingClientRect();
  const pow = document.createElement("span");
  pow.className = "pow";
  pow.textContent = "POW!";
  pow.style.left = `${box.left + box.width / 2}px`;
  pow.style.top = `${box.top + window.scrollY - 10}px`;
  document.body.appendChild(pow);
  setTimeout(() => pow.remove(), 1000);
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 450);
  if (navigator.vibrate) navigator.vibrate(60);
}

const PING_EFFECT = { kiss: heartBurst, hug: hugEffect, punch: punchEffect };

pingButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const type = button.dataset.type;
    button.disabled = true;
    PING_EFFECT[type](button);
    pingStatus.textContent = "Sending...";

    const { data, error } = await supabase.functions.invoke("send-kiss", { body: { type } });

    if (data?.error === "Slow down" || error?.context?.status === 429) {
      pingStatus.textContent = "Easy there. Try again in a minute.";
    } else if (error || !data?.ok) {
      pingStatus.textContent = "Didn't send. Try again.";
    } else if (data.sent === 0) {
      pingStatus.textContent = "Sent, but no phones have alerts on.";
    } else {
      pingStatus.textContent = PING_DONE[type];
      afterPing(type);
      loadScores();
      if (data.milestone) setTimeout(() => showMilestone(data.milestone), 600);
    }

    // Short cooldown so a button can't be spammed by accident
    setTimeout(() => {
      button.disabled = false;
      pingStatus.textContent = "";
    }, 3000);
  });
});


// ---------- EASTER EGGS ----------
// Hidden on purpose. Nothing in the app points to them.
//   note   tap the headline 7 times
//   combo  tap Kiss, Hug, Punch in order, fast
//   roll   tap the plane on the map 5 times
//   shake  shake the phone to send a punch
//   meter  press and hold the "Live" chip
//   night  open the app between 2 and 4 AM
//   ko     10 punches within a minute
//   storm  10 kisses within a minute
// Plus birthday mode on her birthday (set in the secrets table).

const EGG_TOTAL = 8;
let eggsFound = new Set();
let eggDates = {};          // egg -> when it was found
let secrets = null;

async function loadSecrets() {
  if (secrets || isFamily) return secrets || {};
  const { data } = await supabase.from("secrets").select("key, value");
  secrets = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return secrets;
}

// Count: your own finds; on Josh's phone, Arc's finds
async function loadEggs() {
  if (isFamily) return;
  const who = myName.toLowerCase() === "josh" ? arcProfile()?.id : myId;
  if (!who) return renderEggCounter();
  const { data } = await supabase.from("easter_eggs").select("egg, found_at").eq("user_id", who);
  eggsFound = new Set((data || []).map((r) => r.egg));
  eggDates = Object.fromEntries((data || []).map((r) => [r.egg, r.found_at]));
  renderEggCounter();
}

function renderEggCounter() {
  const el = document.getElementById("egg-counter");
  if (!el) return;
  if (isFamily || eggsFound.size === 0) { el.classList.add("hidden"); return; }
  el.textContent = myName.toLowerCase() === "josh"
    ? `${otherName()} found ${eggsFound.size} of ${EGG_TOTAL} easter eggs`
    : `${eggsFound.size} of ${EGG_TOTAL} easter eggs found`;
  el.classList.remove("hidden");
}

const toastEl = document.createElement("div");
toastEl.className = "egg-toast hidden";
document.body.appendChild(toastEl);
function eggToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  toastEl.classList.remove("show"); void toastEl.offsetWidth; toastEl.classList.add("show");
  clearTimeout(eggToast.t);
  eggToast.t = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

async function eggFound(key, always = false) {
  if (isFamily) return;
  const mine = myName.toLowerCase() !== "josh";
  if (mine && eggsFound.has(key)) {                 // already found: no repeat toast
    if (always && !location.hash.startsWith("#demo")) supabase.functions.invoke("send-kiss", { body: { egg: key } }).catch(() => {});
    return;
  }
  if (mine) { eggsFound.add(key); eggDates[key] = new Date().toISOString(); renderEggCounter(); eggToast(`Easter egg found · ${eggsFound.size} of ${EGG_TOTAL}`); }
  if (location.hash.startsWith("#demo")) return;    // previews save nothing
  supabase.functions.invoke("send-kiss", { body: { egg: key } }).catch(() => {});
}

// Count fast taps: returns true on the Nth tap within the time window
function tapCounter(n, ms) {
  let times = [];
  return () => {
    const now = Date.now();
    times = times.filter((t) => now - t < ms);
    times.push(now);
    if (times.length >= n) { times = []; return true; }
    return false;
  };
}

// 1. Secret note: tap the headline 7 times
const headlineTaps = tapCounter(7, 3000);
document.getElementById("headline-title").addEventListener("click", async () => {
  if (isFamily || !headlineTaps()) return;
  const sec = await loadSecrets();
  const note = sec.secret_note || "You found the secret note. Josh hasn't written it yet ;)";
  openSheet(`
    <p class="sheet-kicker">Shh</p>
    <h2 class="sheet-title">A secret note</h2>
    <div class="m-card egg-note"><p class="m-note">${escapeHtml(note).replace(/\n/g, "<br>")}</p><p class="m-sign">Josh</p></div>`);
  eggFound("note");
});

// 2. The combo: Kiss, Hug, Punch in order within 3 seconds
let comboSeq = [];
pingButtons.forEach((b) => b.addEventListener("pointerdown", () => {
  const now = Date.now();
  comboSeq = comboSeq.filter((c) => now - c.t < 3000);
  comboSeq.push({ type: b.dataset.type, t: now });
  const last = comboSeq.slice(-3).map((c) => c.type).join(",");
  if (last === "kiss,hug,punch") { comboSeq = []; setTimeout(showCombo, 250); }
}));
function showCombo() {
  const el = document.createElement("div");
  el.className = "combo";
  el.innerHTML = `<span class="combo-word">COMBO!</span><span class="combo-sub">Kiss · Hug · Punch</span>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 120]);
  setTimeout(() => el.remove(), 1900);
  eggFound("combo");
}

// 3. Barrel roll: tap the plane on the map 5 times
const planeTaps = tapCounter(5, 3000);
document.getElementById("map").addEventListener("click", (e) => {
  const plane = e.target.closest(".map-plane");
  if (!plane || !planeTaps()) return;
  plane.classList.remove("roll"); void plane.offsetWidth; plane.classList.add("roll");
  setTimeout(() => plane.classList.remove("roll"), 1400);
  eggFound("roll");
});

// 4. Shake the phone to send a punch
// How it works: each motion reading gives the phone's acceleration. A hard shake makes short
// spikes well above normal handling. 3 spikes within 1.2 seconds = a shake.
const SHAKE_FORCE = 13;      // m/s² above normal (about 1.3 g). Lower = easier to trigger.
let shakeHits = [], lastShake = 0, lastPeak = 0, motionOn = false;
let shakeDebug = null;       // #demo-shake shows the live readings
function onMotion(e) {
  let force;
  const a = e.acceleration;                         // without gravity (most phones)
  if (a && a.x != null) force = Math.hypot(a.x, a.y, a.z);
  else {
    const g = e.accelerationIncludingGravity;       // with gravity: subtract 9.8
    if (!g || g.x == null) return;
    force = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  }
  const now = Date.now();
  if (shakeDebug) shakeDebug.update(force, shakeHits.length);
  if (force < SHAKE_FORCE || now - lastPeak < 120) return;   // one count per spike
  lastPeak = now;
  shakeHits = shakeHits.filter((t) => now - t < 1200);
  shakeHits.push(now);
  if (shakeHits.length < 3 || now - lastShake < 6000 || document.hidden) return;
  lastShake = now; shakeHits = [];
  if (shakeDebug) shakeDebug.fired();
  const punch = document.querySelector(".ping-punch");
  if (isFamily || !punch || dashboardView.classList.contains("hidden")) return;
  if (punch.disabled) { eggToast("Shake again in a few seconds"); return; }
  punch.click();
  eggFound("shake");
}

// #demo-shake: a small readout to check the phone's motion sensor
function showShakeDebug() {
  const el = document.createElement("div");
  el.className = "shake-debug";
  el.innerHTML = `<strong>Shake test</strong><span class="sd-force">waiting for sensor…</span><span class="sd-hits"></span>`;
  document.body.appendChild(el);
  let peak = 0;
  shakeDebug = {
    update(f, hits) {
      peak = Math.max(peak * 0.98, f);
      el.querySelector(".sd-force").textContent = `force ${f.toFixed(1)} · peak ${peak.toFixed(1)} (needs ${SHAKE_FORCE})`;
      el.querySelector(".sd-hits").textContent = `spikes ${hits}/3`;
    },
    fired() { el.classList.add("hit"); setTimeout(() => el.classList.remove("hit"), 800); },
  };
}

function startMotion() {
  if (motionOn || isFamily) return;
  motionOn = true;
  window.addEventListener("devicemotion", onMotion);
}
// iPhone asks for motion permission; ask once, on her first tap of a ping button
async function askMotion() {
  if (motionOn || isFamily) return;
  const ask = window.DeviceMotionEvent?.requestPermission;
  if (typeof ask !== "function") return startMotion();       // Android: no prompt needed
  let asked = null;
  try { asked = localStorage.getItem("jt-motion"); } catch { /* storage off */ }
  if (asked === "denied") return;
  try {
    const result = await ask();
    try { localStorage.setItem("jt-motion", result); } catch { /* storage off */ }
    if (result === "granted") startMotion();
  } catch { /* not allowed here */ }
}
pingButtons.forEach((b) => b.addEventListener("click", askMotion));
if (typeof window.DeviceMotionEvent?.requestPermission !== "function") startMotion();

// 5. Love meter: press and hold the "Live" chip
const liveChip = document.querySelector(".live");
let holdTimer = null;
liveChip.addEventListener("pointerdown", () => { holdTimer = setTimeout(showLoveMeter, 700); });
["pointerup", "pointerleave", "pointercancel"].forEach((ev) => liveChip.addEventListener(ev, () => clearTimeout(holdTimer)));
liveChip.addEventListener("contextmenu", (e) => e.preventDefault());

function showLoveMeter() {
  const who = isFamily ? "Josh" : otherName();
  const el = document.createElement("div");
  el.className = "meter";
  el.innerHTML = `
    <div class="meter-card">
      <p class="meter-kicker">Live reading</p>
      <p class="meter-title">${escapeHtml(who)} is thinking about you</p>
      <div class="meter-bar"><div class="meter-fill"></div></div>
      <p class="meter-num"><span>0</span>%</p>
      <p class="meter-sub"></p>
    </div>`;
  document.body.appendChild(el);
  const num = el.querySelector(".meter-num span"), fill = el.querySelector(".meter-fill"), sub = el.querySelector(".meter-sub");
  const start = performance.now();
  const tick = (t) => {
    const k = (t - start) / 1000;
    let v;
    if (k < 1.6) v = Math.round(100 * (1 - Math.pow(1 - k / 1.6, 3)));       // ease up to 100
    else v = Math.round(100 + Math.pow((k - 1.6) * 6, 2.6));                    // then it breaks
    if (v > 9999) {
      num.parentElement.innerHTML = "∞";
      sub.textContent = "Meter broken. Too much love.";
      el.classList.add("broken");
      if (navigator.vibrate) navigator.vibrate([30, 30, 30, 30, 200]);
      return;
    }
    num.textContent = v;
    fill.style.width = `${Math.min(100, v)}%`;
    if (v > 100) el.classList.add("over");
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  el.addEventListener("click", () => el.remove());
  if (!isFamily) eggFound("meter");
}



// 7 + 8. K.O. and Kiss storm: 10 punches (or kisses) sent within a minute
const sentTimes = { kiss: [], hug: [], punch: [] };
function afterPing(type) {
  const now = Date.now();
  sentTimes[type] = (sentTimes[type] || []).filter((t) => now - t < 60000);
  sentTimes[type].push(now);
  if (sentTimes[type].length >= 10) {
    sentTimes[type] = [];
    if (type === "punch") showKO();
    if (type === "kiss") showKissStorm();
  }
}

function showKO() {
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<span class="ko-star" style="--a:${i * 72}deg">★</span>`).join("");
  const el = document.createElement("div");
  el.className = "ko";
  el.innerHTML = `
    <div class="ko-inner">
      <div class="ko-stars">${stars}</div>
      <span class="ko-word">K.O.!</span>
      <span class="ko-sub">Josh is down for the count</span>
      <span class="ko-count">10 · 9 · 8 · 7 · …</span>
    </div>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate([200, 60, 200, 60, 400]);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.remove(), 4200);
  eggFound("ko", true);
}

function showKissStorm() {
  const heart = document.querySelector(".ping-kiss .ping-orb svg")?.outerHTML || "♥";
  const hearts = Array.from({ length: 60 }, (_, i) =>
    `<span class="storm-heart" style="left:${(i * 53) % 100}%;animation-delay:${(i % 15) * 0.12}s;animation-duration:${1.8 + (i % 6) * 0.35}s;--s:${0.5 + (i % 5) * 0.3};--r:${(i * 37) % 60 - 30}deg">${heart}</span>`).join("");
  const el = document.createElement("div");
  el.className = "storm";
  el.innerHTML = `${hearts}<div class="storm-text"><span class="storm-word">Kiss storm</span><span class="storm-sub">Josh's phone is having a moment</span></div>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate([30, 30, 30, 30, 30, 30, 30, 30, 200]);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.remove(), 4500);
  eggFound("storm", true);
}

// 9. Night owl: opening the app between 2 and 4 AM (on her phone's clock), once a night
function maybeNightOwl(force = false) {
  if (isFamily) return;
  const now = new Date();
  if (!force && (now.getHours() < 2 || now.getHours() >= 4)) return;
  const night = now.toDateString();
  let shown = null;
  try { shown = localStorage.getItem("jt-nightowl"); } catch { /* storage off */ }
  if (!force && shown === night) return;
  try { localStorage.setItem("jt-nightowl", night); } catch { /* storage off */ }
  const twinkles = Array.from({ length: 40 }, (_, i) =>
    `<span class="owl-star" style="left:${(i * 47) % 100}%;top:${(i * 29) % 70}%;animation-delay:${(i % 10) * 0.3}s"></span>`).join("");
  const el = document.createElement("div");
  el.className = "owl";
  el.innerHTML = `
    ${twinkles}
    <div class="owl-inner">
      <svg class="owl-moon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#ffe7a3" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>
      <p class="owl-time">${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</p>
      <h1 class="owl-title">Why are you awake?</h1>
      <p class="owl-text">Go to sleep. I'll still be here in the morning.</p>
      <p class="owl-sign">— Josh</p>
      <button type="button" class="owl-close">Okay, goodnight</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".owl-close").addEventListener("click", () => el.remove());
  eggFound("night");
}

// The list of eggs: tap the counter line to open it
const EGG_LIST = [
  { key: "note",  name: "Secret note",  how: "Tap the headline 7 times.",          does: "Opens a hidden note from Josh.",       hint: "The headline has more to say. Be persistent." },
  { key: "combo", name: "The combo",    how: "Tap Kiss, Hug, Punch fast, in order.", does: "COMBO!",                              hint: "Some things are better in the right order." },
  { key: "roll",  name: "Barrel roll",  how: "Tap the plane on the map 5 times.",  does: "The plane does a loop-the-loop.",      hint: "Pilots love to show off." },
  { key: "shake", name: "Shake punch",  how: "Shake your phone.",                  does: "Sends Josh a punch.",                  hint: "Sometimes you just want to shake him." },
  { key: "meter", name: "Love meter",   how: "Press and hold the Live chip.",      does: "Measures how much Josh is thinking about you.", hint: "Hold on to what's live." },
  { key: "night", name: "Night owl",    how: "Open the app between 2 and 4 AM.",   does: "Josh tells you to go to sleep.",       hint: "Some things only happen when you should be asleep." },
  { key: "ko",    name: "K.O.",         how: "Send 10 punches within a minute.",   does: "Knocks Josh out cold.",                hint: "Float like a butterfly…" },
  { key: "storm", name: "Kiss storm",   how: "Send 10 kisses within a minute.",    does: "A storm of hearts, and Josh hears about it.", hint: "Some days one kiss isn't enough." },
];

function birthdaySeen() {
  try { return !!localStorage.getItem("jt-birthday"); } catch { return false; }
}

function openEggList() {
  const josh = myName.toLowerCase() === "josh";
  const lock = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>`;
  const egg = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3c3.6 0 6.5 5.4 6.5 10a6.5 6.5 0 0 1-13 0C5.5 8.4 8.4 3 12 3z"/></svg>`;
  const rows = EGG_LIST.map((e) => {
    const found = eggsFound.has(e.key);
    const when = found && eggDates[e.key] ? ` · found ${formatDay(eggDates[e.key])}` : "";
    if (found) {
      return `<button type="button" class="egg-row${found ? " found" : ""}" data-egg="${e.key}">
        <span class="egg-icon">${found ? egg : lock}</span>
        <span class="egg-text"><strong>${e.name}</strong><span>${e.how} ${e.does}${when}</span></span>
      </button>`;
    }
    return `<div class="egg-row locked">
        <span class="egg-icon">${lock}</span>
        <span class="egg-text"><strong>???</strong><span>${e.hint}</span></span>
      </div>`;
  }).join("");
  const bday = birthdaySeen();
  const bonus = `<div class="egg-row bonus${bday ? " found" : " locked"}">
      <span class="egg-icon">${bday ? egg : lock}</span>
      <span class="egg-text"><strong>${bday ? "Birthday mode" : "A special day"}</strong><span>${bday ? "On your birthday, the whole app celebrates." : "Wait for it."}</span></span>
    </div>`;
  openSheet(`
    <p class="sheet-kicker">${josh ? `${otherName()} has found ${eggsFound.size} of ${EGG_TOTAL}` : `${eggsFound.size} of ${EGG_TOTAL} found`}</p>
    <h2 class="sheet-title">Easter eggs</h2>
    <div class="egg-list">${rows}${bonus}</div>
    ${josh ? "" : `<p class="sheet-note">Tap one you've found to see it again.</p>`}`);
}

// Replay a found egg from the list
document.getElementById("sheet-body").addEventListener("click", (e) => {
  const key = e.target.closest(".egg-row.found[data-egg]")?.dataset.egg;
  if (!key) return;
  closeSheet();
  if (key === "note") { for (let i = 0; i < 7; i++) document.getElementById("headline-title").click(); }
  else if (key === "combo") showCombo();
  else if (key === "meter") showLoveMeter();
  else if (key === "night") maybeNightOwl(true);
  else if (key === "ko") showKO();
  else if (key === "storm") showKissStorm();
  else if (key === "roll") {
    const plane = document.querySelector(".map-plane");
    if (plane) { plane.classList.remove("roll"); void plane.offsetWidth; plane.classList.add("roll"); plane.scrollIntoView({ behavior: "smooth", block: "center" }); }
    else eggToast("Only while Josh is flying");
  } else if (key === "shake") eggToast("Shake your phone to punch Josh");
});

const eggCounterEl = document.getElementById("egg-counter");
eggCounterEl.setAttribute("role", "button");
eggCounterEl.setAttribute("tabindex", "0");
eggCounterEl.addEventListener("click", openEggList);
eggCounterEl.addEventListener("keydown", (e) => { if (e.key === "Enter") openEggList(); });

// 6. Birthday mode: on her birthday (Eastern), once that day
async function maybeBirthday(force = false) {
  if (isFamily) return;
  if (!force && myName.toLowerCase() === "josh") return;
  const sec = force ? { birthday_message: "This is a preview. Your birthday message shows here, word for word." } : await loadSecrets();
  const today = dayKeyET(Date.now());                       // "2026-03-14"
  if (!force && sec.birthday !== today.slice(5)) return;
  let shown = null;
  try { shown = localStorage.getItem("jt-birthday"); } catch { /* storage off */ }
  if (!force && shown === today) return;
  try { localStorage.setItem("jt-birthday", today); } catch { /* storage off */ }

  const cake = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="9" rx="2" fill="#ff6f91"/><path d="M4 14.5q2 1.6 4 0t4 0 4 0 4 0" fill="none" stroke="#fff" stroke-width="1.4"/><rect x="11.2" y="6" width="1.6" height="5" rx=".8" fill="#ffb547"/><path d="M12 2.5c1 1.2 1 2.2 0 3-1-.8-1-1.8 0-3z" fill="#ff4545"/></svg>`;
  const floaters = Array.from({ length: 24 }, (_, i) =>
    `<span class="m-float" style="left:${(i * 41) % 100}%;animation-delay:${(i % 8) * 0.4}s;animation-duration:${4 + (i % 5)}s;--s:${0.6 + (i % 4) * 0.25}">${cake}</span>`).join("");
  const el = document.createElement("div");
  el.className = "milestone birthday";
  el.innerHTML = `
    <div class="m-floaters" aria-hidden="true">${floaters}</div>
    <div class="m-inner">
      <div class="m-badge"><span class="m-icon">${cake}</span></div>
      <p class="m-kicker">Today is your day</p>
      <h1 class="m-count">Happy Birthday, ${escapeHtml(myName.toLowerCase() === "josh" ? "Arc" : myName)}</h1>
      <div class="m-card"><p class="m-note">${escapeHtml(sec.birthday_message || "Happy birthday!").replace(/\n/g, "<br>")}</p><p class="m-sign">Josh</p></div>
      <button type="button" class="m-close">Best day ever</button>
    </div>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 160]);
  el.querySelector(".m-close").addEventListener("click", () => el.remove());
}

// ---------- WELCOME NOTE ----------
// Shows once when the user has "showWelcome": true in their account (set with SQL).
// The note text lives in the welcome_note table, so it never appears in the public code.

const welcome = document.getElementById("welcome");
const steps = [...welcome.querySelectorAll(".step")];
const dots = document.getElementById("welcome-dots");
const backBtn = document.getElementById("welcome-back");
const nextBtn = document.getElementById("welcome-next");
let stepIndex = 0;
let markSeenOnClose = false;

function showStep(i) {
  stepIndex = i;
  steps.forEach((s, n) => s.classList.toggle("hidden", n !== i));
  dots.innerHTML = steps.map((_, n) => `<span class="dot${n === i ? " on" : ""}"></span>`).join("");
  backBtn.classList.toggle("invisible", i === 0);
  nextBtn.textContent = i === steps.length - 1 ? "Let's go ♥" : "Next";
  if (i === 2) renderWelcomeAlerts();
  welcome.scrollTop = 0;
}

// Step 3: show whether alerts are on, with a button if they're not
function renderWelcomeAlerts() {
  const box = document.getElementById("welcome-alerts");
  const cardShowing = !alertsCard.classList.contains("hidden");
  const buttonShowing = !alertsButton.classList.contains("hidden");
  if (!cardShowing) {
    box.innerHTML = `<p class="alerts-on">✓ Alerts are on</p>`;
  } else if (buttonShowing) {
    box.innerHTML = `<button type="button" id="welcome-alerts-btn">Turn on alerts</button>`;
    document.getElementById("welcome-alerts-btn").addEventListener("click", () => {
      alertsButton.click();
      setTimeout(renderWelcomeAlerts, 1500);
    });
  } else {
    box.innerHTML = `<p class="welcome-small">${alertsText.textContent}</p>`;
  }
}

async function loadNote() {
  const { data } = await supabase.from("welcome_note").select("*").eq("id", 1).maybeSingle();
  if (data) {
    document.getElementById("welcome-title").textContent = data.title || "Happy anniversary";
    document.getElementById("welcome-message").textContent = data.message || "";
    document.getElementById("welcome-signoff").textContent = data.signoff || "";
  }
}

async function openWelcome(markSeen) {
  markSeenOnClose = markSeen;
  await loadNote();
  showStep(0);
  welcome.classList.remove("hidden");
  document.body.classList.add("no-scroll");
}

async function closeWelcome() {
  welcome.classList.add("hidden");
  document.body.classList.remove("no-scroll");
  if (markSeenOnClose) {
    await supabase.auth.updateUser({ data: { showWelcome: false } });
    markSeenOnClose = false;
  }
}

backBtn.addEventListener("click", () => stepIndex > 0 && showStep(stepIndex - 1));
nextBtn.addEventListener("click", () => {
  if (stepIndex < steps.length - 1) showStep(stepIndex + 1);
  else closeWelcome();
});
document.getElementById("open-welcome").addEventListener("click", () => openWelcome(false));

// Called after sign-in: open the note if this account is flagged for it
async function maybeShowWelcome() {
  const { data: { user } } = await supabase.auth.getUser(); // fresh from the server
  if (user?.user_metadata?.showWelcome && user?.app_metadata?.role !== "family") { openWelcome(true); return; }
  maybeShowIntro();
}

// ---------- WHAT'S NEW (Arc) / WELCOME (Mom) ----------
// Shows once per phone. Change APP_VERSION to show a new "What's new" after a future update.

const APP_VERSION = "3.0";
const INTRO_ICON = {
  heart: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 20C7 16 4 13 4 9.5 4 7 6 5 8.3 5c1.6 0 3 1 3.7 2.4"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="0.1 3.2" d="M12 7.4C12.7 6 14.1 5 15.7 5 18 5 20 7 20 9.5c0 3.5-3 6.5-8 10.5"/></svg>`,
  bed: ICON.bed, cal: ICON.calendar, clock: ICON.clock, pin: ICON.pin, home: ICON.home,
  plane: ICON.plane(45),
  bolt: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M13 3L5 13h6l-1 8 8-10h-6l1-8z"/></svg>`,
  gift: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1zm0 0c1.5-3 5-3 5-1s-3 1-5 1z"/></svg>`,
};

const introEl = document.createElement("div");
introEl.className = "welcome intro hidden";
introEl.setAttribute("role", "dialog");
introEl.setAttribute("aria-modal", "true");
document.body.appendChild(introEl);

function introItem(icon, title, text) {
  return `<li><span class="tour-icon">${icon}</span><div><strong>${title}</strong><span>${text}</span></div></li>`;
}

function showIntro(kind) {
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isAndroid = /Android/.test(navigator.userAgent);
  const body = kind === "mom" ? `
      <p class="kicker">Welcome</p>
      <h2>Hi Mom</h2>
      <p class="intro-lead">Now you can always see where I am and where I'm headed. It updates by itself from my calendar.</p>
      <ul class="tour">
        ${introItem(INTRO_ICON.pin, "The headline", "Where I am right now: home, on the road, at a hotel, or in the air.")}
        ${introItem(INTRO_ICON.clock, "The countdown", "When I take off or land, with any delays, in your time.")}
        ${introItem(INTRO_ICON.plane, "The map", "My plane moving across the country while I fly.")}
        ${introItem(INTRO_ICON.home, "Home in", "How long until I'm back home.")}
        ${introItem(INTRO_ICON.cal, "This week", "Where I'll be each day. Tap a day for the details.")}
      </ul>
      ${!installed && isAndroid ? `<p class="welcome-small">Tip: in Chrome, tap ⋮ (top right), then <strong>Install app</strong>. Then open JoshTracker from your home screen.</p>` : ""}
      <p class="welcome-small">Love, Josh</p>`
    : `
      <p class="kicker">JoshTracker ${APP_VERSION}</p>
      <h2>What's new</h2>
      <ul class="tour">
        ${introItem(INTRO_ICON.heart, "A new look", "The new icon is our route: red is where I've been, the dots are my way back to you.")}
        ${introItem(INTRO_ICON.bed, "Hotel stays", "The app now knows when I'm staying over, even on trips I drive to.")}
        ${introItem(INTRO_ICON.cal, "Tap for details", "Tap any flight or hotel in This week to see times, places, and a map link.")}
        ${introItem(INTRO_ICON.clock, "My time", "When I'm in another time zone, you'll see what time it is for me.")}
        ${introItem(INTRO_ICON.bolt, "Faster", "Opens instantly, even with bad signal, and updates the moment something changes.")}
        ${introItem(INTRO_ICON.gift, "Keep them coming", "Every kiss, hug, and punch counts. Don't stop now ;)")}
      </ul>`;
  introEl.innerHTML = `
    <div class="welcome-inner">
      <section class="step">${body}</section>
      <button type="button" class="intro-done">${kind === "mom" ? "Got it" : "Love it"}</button>
    </div>`;
  introEl.classList.remove("hidden");
  introEl.querySelector(".intro-done").addEventListener("click", () => {
    introEl.classList.add("hidden");
    try { localStorage.setItem(`jt-intro-${kind}`, APP_VERSION); } catch { /* storage off */ }
  });
}

function maybeShowIntro() {
  const kind = isFamily ? "mom" : "whatsnew";
  if (location.hash === "#demo-whatsnew") return showIntro("whatsnew");   // previews
  if (location.hash === "#demo-momwelcome") return showIntro("mom");
  if (myName.toLowerCase() === "josh") return;                             // you know what's new
  let seen = null;
  try { seen = localStorage.getItem(`jt-intro-${kind}`); } catch { /* storage off */ }
  if (seen !== APP_VERSION) showIntro(kind);
}

// ---------- SIGN IN / SIGN OUT ----------

function startTimers() {
  stopTimers();
  timers.push(setInterval(render, 1000));        // update countdowns every second
  // Realtime brings changes at once; this slower refresh is only a safety net
  timers.push(setInterval(loadFlights, 5 * 60000));
  if (!isFamily) timers.push(setInterval(() => { loadVisit(); loadScores(); }, 5 * 60000));
}
function stopTimers() {
  timers.forEach(clearInterval);
  timers = [];
}

async function showCorrectView() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    loginView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    await loadMe();
    showSnapshot();            // last known data, on screen at once
    await loadFlights();       // then fresh data
    if (!isFamily) {
      loadVisit();
      loadScores();
      checkMilestones();
      loadCoupons();
      loadEggs();
      if (location.hash === "#demo-birthday") maybeBirthday(true); else maybeBirthday();
      if (location.hash === "#demo-nightowl") maybeNightOwl(true); else maybeNightOwl();
      if (location.hash === "#demo-shake") { showShakeDebug(); askMotion(); }
      if (location.hash === "#demo-ko") showKO();
      if (location.hash === "#demo-storm") showKissStorm();
    }
    startTimers();
    startRealtime();
    previewMilestone();
    if (!isFamily) {
      await refreshAlertsCard();
      maybeShowWelcome();      // the welcome note, or else "What's new"
    } else {
      maybeShowIntro();        // Mom's one-time welcome
    }
    clearBadge();
  } else {
    stopTimers();
    stopRealtime();
    document.body.classList.remove("family");
    dashboardView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the page from reloading
  loginError.textContent = "";
  const { error } = await supabase.auth.signInWithPassword({
    email: document.getElementById("email").value,
    password: document.getElementById("password").value,
  });
  if (error) {
    loginError.textContent = error.message;
  } else {
    showCorrectView();
  }
});

logoutButton.addEventListener("click", async () => {
  await supabase.auth.signOut();
  showCorrectView();
});

// Refresh right away when she comes back to the app
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !timers.length) return;
  clearBadge();
  maybeNightOwl();
  loadFlights();
  if (!isFamily) { loadScores(); loadVisit(); checkMilestones(); }
});

window.addEventListener("hashchange", () => { if (timers.length) loadFlights(); });

showCorrectView();
