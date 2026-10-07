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

// The hotel stay that covers the night of this day ("2026-10-07"), if any
function stayOnNight(dayKey) {
  return stays.find((s) => dayKeyET(s.check_in) <= dayKey && dayKey < dayKeyET(s.check_out)) || null;
}

// A hotel stay wins the headline unless a flight is in the air, just landed, or has a problem
function stayShowing(hero) {
  const stay = currentStay();
  if (!stay) return null;
  return !hero || phaseOf(hero) === "upcoming" ? stay : null;
}

function renderHeadline(hero) {
  let kicker = "", title = "", sub = "";
  const stay = stayShowing(hero);

  if (stay) {
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
  const upcomingStays = stays.filter((s) => new Date(s.check_out).getTime() > Date.now());
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
        <div class="tl-flight">
          <span class="tl-route">${f.origin} → ${f.destination}</span>
          <span class="tl-time">${formatAt(departureTime(f), null, false)} · ${f.flightNumber}</span>
        </div>`).join("");
      icon = `<span class="tl-icon fly">${ICON.plane(f0dir(todays[0]))}</span>`;
      where = todays[todays.length - 1].destination;
    } else if (stayNight) {
      body = `<span class="tl-where">In ${escapeHtml(stayNight.city)} · hotel</span>`;
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

  el.innerHTML = rows.join("");
  el.classList.remove("hidden");
  title.classList.remove("hidden");
}

// Plane icon direction for the week list: east-bound points right, west-bound points left
function f0dir(f) {
  if (f.originLon != null && f.destinationLon != null) return f.destinationLon >= f.originLon ? 90 : -90;
  return 90;
}

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
  renderHero(hero);
  renderHomeCard(hero);
  renderVisit();
  renderTimeline();
}

// ---------- WHO IS SIGNED IN ----------

let myName = "";
const otherName = () => (myName.toLowerCase() === "josh" ? "Arc" : "Josh");

async function loadMe() {
  const { data: { user } } = await supabase.auth.getUser();
  myName = user?.user_metadata?.name || "";
  document.getElementById("me-avatar").textContent = (myName || "?").slice(0, 1).toUpperCase();
  document.getElementById("me-hi").textContent = myName ? `Hi, ${myName}` : "Hi";
  document.getElementById("ping-title").textContent = `Send ${otherName()} something`;
}

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
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data, error } = await supabase.from("pings").select("sender_name, type").gte("created_at", since);
  const el = document.getElementById("score-card");
  if (error) { el.classList.add("hidden"); return; }

  // Count per person per type
  const people = {};
  for (const name of ["Arc", "Josh"]) people[name] = { kiss: 0, hug: 0, punch: 0 };
  for (const row of data || []) {
    const name = (row.sender_name || "").toLowerCase() === "josh" ? "Josh" : "Arc";
    people[name] = people[name] || { kiss: 0, hug: 0, punch: 0 };
    if (people[name][row.type] !== undefined) people[name][row.type]++;
  }

  el.innerHTML = `
    <div class="score-head"><span>Last 7 days</span></div>
    ${Object.entries(people).map(([name, c]) => `
      <div class="score-row">
        <span class="score-name">${escapeHtml(name)}</span>
        <span class="score-cell">${SCORE_ICON.kiss}${c.kiss}</span>
        <span class="score-cell">${SCORE_ICON.hug}${c.hug}</span>
        <span class="score-cell">${SCORE_ICON.punch}${c.punch}</span>
      </div>`).join("")}
  `;
  el.classList.remove("hidden");
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
  render();
  renderMap(pickHero(flights)); // the map only redraws when new data comes in
  maybeCelebrate(false);
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

  alertsText.textContent = "Get a ping when Josh departs, lands, or is delayed.";
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

    if (error || !data?.ok) {
      pingStatus.textContent = "Didn't send. Try again.";
    } else if (data.sent === 0) {
      pingStatus.textContent = "Sent, but no phones have alerts on.";
    } else {
      pingStatus.textContent = PING_DONE[type];
      loadScores();
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
  if (user?.user_metadata?.showWelcome) openWelcome(true);
}

// ---------- SIGN IN / SIGN OUT ----------

function startTimers() {
  stopTimers();
  timers.push(setInterval(render, 1000));        // update countdowns every second
  timers.push(setInterval(loadFlights, 60000));  // get fresh data every minute
  timers.push(setInterval(() => { loadVisit(); loadScores(); }, 60000));
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
    await loadFlights();
    loadVisit();
    loadScores();
    startTimers();
    await refreshAlertsCard();
    maybeShowWelcome();
  } else {
    stopTimers();
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
  if (!document.hidden && timers.length) loadFlights();
});

window.addEventListener("hashchange", () => { if (timers.length) loadFlights(); });

showCorrectView();
