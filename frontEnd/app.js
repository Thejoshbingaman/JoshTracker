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
  MCI: "Kansas City", SAT: "San Antonio", SEA: "Seattle", PDX: "Portland",
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

  for (let i = 0; i < 7; i++) {
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
  document.getElementById("sheet-body").innerHTML = html;
  sheet.classList.remove("hidden");
}
function closeSheet() { sheet.classList.add("hidden"); }
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
    mapLayers = L.layerGroup().addTo(map);
  }
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
      interactive: false,
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
  loadFlights();
  if (!isFamily) { loadScores(); loadVisit(); checkMilestones(); }
});

window.addEventListener("hashchange", () => { if (timers.length) loadFlights(); });

showCorrectView();
