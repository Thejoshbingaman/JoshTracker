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

function renderHeadline(hero) {
  let kicker = "", title = "", sub = "";
  const now = Date.now();

  if (!hero) {
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
      sub = `Lands in ${formatDuration(new Date(arrivalTime(hero)) - now)}`;
    } else if (phase === "landed") {
      kicker = "Just landed";
      title = `Josh landed in ${dest}`;
      sub = `at ${formatAt(arrivalTime(hero), hero.arrivalLocal, false)}`;
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
      sub = `Flies to ${dest} in ${formatDuration(new Date(departureTime(hero)) - now)}`;
    }
  }

  document.getElementById("headline-kicker").textContent = kicker;
  document.getElementById("headline-title").textContent = title;
  document.getElementById("headline-sub").textContent = sub;
}

// Small line at the bottom of the card: how fresh is the data?
function updatedLine(f, phase) {
  if (!f.lastCheckedUtc) {
    return `<p class="updated"><span class="fresh-dot dot-idle"></span>Live tracking starts 3 hr before departure</p>`;
  }
  const mins = (Date.now() - new Date(f.lastCheckedUtc).getTime()) / 60000;
  // During a flight, data older than 45 min means something may be stuck
  const stale = (phase === "air" || phase === "upcoming") && mins > 45;
  return `<p class="updated"><span class="fresh-dot ${stale ? "dot-stale" : "dot-fresh"}"></span>Live data · updated ${timeAgo(f.lastCheckedUtc)}</p>`;
}

function renderHero(hero) {
  const el = document.getElementById("hero");
  if (!hero) { el.innerHTML = ""; return; }

  const phase = phaseOf(hero);
  const now = Date.now();
  const dep = new Date(departureTime(hero)).getTime();
  const arr = new Date(arrivalTime(hero)).getTime();

  // How far along the route line the plane sits (0 to 100)
  const progress = progressOf(hero) * 100;

  // Countdown text
  let countLabel = "", countValue = "";
  if (phase === "upcoming") { countLabel = "Departs in"; countValue = formatDuration(dep - now); }
  if (phase === "air") { countLabel = "Lands in"; countValue = formatDuration(arr - now); }
  if (phase === "landed") { countLabel = "Landed"; countValue = formatAt(arrivalTime(hero), hero.arrivalLocal, false); }

  const delay = delayMinutes(hero);
  // The pill follows what the card shows, so it can't say "In the air" after landing
  const statusText =
    phase === "landed" ? "Landed" :
    phase === "air" ? "In the air" :
    STATUS_TEXT[hero.status] || hero.status || "Scheduled";

  // Only show gate / baggage when we have them
  const extras = [];
  if (hero.baggageBelt) extras.push(`<div><span class="label">Baggage</span><span class="time">Belt ${hero.baggageBelt}</span></div>`);

  el.innerHTML = `
    <article class="card hero phase-${phase}">
      <div class="hero-top">
        <span class="flightno">${hero.flightNumber}</span>
        <span class="pills">
          ${delay ? `<span class="pill pill-warn">+${delay} min</span>` : ""}
          <span class="pill pill-${phase}">${statusText}</span>
        </span>
      </div>

      <div class="route">
        <div class="end">
          <span class="code">${hero.origin}</span>
          <span class="city">${city(hero.origin)}</span>
        </div>
        <div class="track">
          <div class="track-fill" style="width:${progress}%"></div>
          <div class="plane" style="left:${progress}%">${PLANE_SVG}</div>
        </div>
        <div class="end end-right">
          <span class="code">${hero.destination}</span>
          <span class="city">${city(hero.destination)}</span>
        </div>
      </div>

      ${countValue ? `
      <div class="countdown">
        <span class="label">${countLabel}</span>
        <span class="big-time">${countValue}</span>
      </div>` : ""}

      <div class="grid">
        <div>
          <span class="label">Departs</span>
          <span class="time">${formatAt(departureTime(hero), hero.departureLocal, false)}</span>
          <span class="day">${formatDay(departureTime(hero), hero.departureLocal)}</span>
          ${delay ? `<span class="was">was ${formatAt(hero.departureUtc, hero.departureLocal, false)}</span>` : ""}
        </div>
        <div>
          <span class="label">Arrives</span>
          <span class="time">${formatAt(arrivalTime(hero), hero.arrivalLocal, false)}</span>
          <span class="day">${formatDay(arrivalTime(hero), hero.arrivalLocal)}</span>
        </div>
        ${extras.join("")}
      </div>

      ${updatedLine(hero, phase)}
    </article>
  `;
}

function renderHomeCard(hero) {
  const el = document.getElementById("home-card");
  if (!hero) { el.innerHTML = ""; return; }

  // First unfinished flight (from the featured one on) that ends at a home airport
  const start = flights.indexOf(hero);
  const homeFlight = flights.slice(start).find(
    (f) => HOME_AIRPORTS.includes(f.destination) && ["upcoming", "air"].includes(phaseOf(f))
  );
  if (!homeFlight) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <article class="card home">
      <div>
        <span class="label">Home in</span>
        <span class="big-time">${formatDuration(new Date(arrivalTime(homeFlight)) - Date.now())}</span>
        <span class="home-sub">Lands at ${homeFlight.destination} · ${formatAt(arrivalTime(homeFlight), homeFlight.arrivalLocal)}</span>
      </div>
      <span class="heart" aria-hidden="true">♥</span>
    </article>
  `;
}

// "Next 7 days": where Josh is each day, and any flights
function renderTimeline() {
  const el = document.getElementById("timeline");
  const title = document.getElementById("timeline-title");

  // Only flights that are not finished
  const active = flights.filter((f) => phaseOf(f) !== "landed" && phaseOf(f) !== "canceled");
  if (active.length === 0) {
    el.classList.add("hidden");
    title.classList.add("hidden");
    return;
  }

  // Day keys like "2026-10-03" on this phone's clock
  const dayKey = dayKeyET;
  const today = new Date();
  today.setHours(12, 0, 0, 0); // midday avoids daylight-saving edge cases

  // Where is he before the first flight? At that flight's origin.
  let where = active[0].origin;
  const rows = [];

  for (let i = 0; i < 7; i++) {
    const day = new Date(today.getTime() + i * 86400000);
    const key = dayKey(day);
    const todays = active.filter((f) => dayKey(departureTime(f)) === key);

    const dow = i === 0 ? "Today" : i === 1 ? "Tomorrow" : day.toLocaleDateString("en-US", { weekday: "short" });
    const date = day.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    let kind, body;
    if (todays.length > 0) {
      kind = "fly";
      body = todays.map((f) => `
        <div class="tl-flight">
          <span class="tl-route">${f.origin} <span class="arrow">→</span> ${f.destination}</span>
          <span class="tl-time">${formatAt(departureTime(f), f.departureLocal, false)} · ${f.flightNumber}</span>
        </div>`).join("");
      where = todays[todays.length - 1].destination; // he ends the day here
    } else if (HOME_AIRPORTS.includes(where)) {
      kind = "home";
      body = `<span class="tl-where">Home</span>`;
    } else {
      kind = "away";
      body = `<span class="tl-where">In ${city(where)}</span>`;
    }

    rows.push(`
      <div class="tl-row${i === 0 ? " tl-today" : ""}">
        <div class="tl-day"><span class="tl-dow">${dow}</span><span class="tl-date">${date}</span></div>
        <div class="tl-dot tl-${kind}"></div>
        <div class="tl-body">${body}</div>
      </div>`);
  }

  el.innerHTML = rows.join("");
  el.classList.remove("hidden");
  title.classList.remove("hidden");
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
  if (toGo.length) L.polyline(toGo, { color: "#4a525a", opacity: 1, weight: 2, dashArray: "3 6" }).addTo(mapLayers);
  if (flown.length) L.polyline(flown, { color: "#e6ebef", weight: 2.5 }).addTo(mapLayers);

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
  renderHero(hero);
  renderHomeCard(hero);
  renderTimeline();
}

// ---------- DATA ----------

// ---------- DEMO MODE ----------
// Add #demo to the address to see fake flights instead of real ones:
//   #demo         = in the air right now (BWI → LAX)
//   #demo-before  = flight leaves in about 2 hours
//   #demo-landed  = just landed
// Nothing is saved and no alerts are sent. Only you see it, on your own screen.

const DEMO_START = Date.now();

function demoFlights(mode) {
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
  return null;
}

async function loadFlights() {
  const mode = demoMode();
  document.body.classList.toggle("demo", !!mode);
  if (mode) {
    flights = demoFlights(mode);
    render();
    renderMap(pickHero(flights));
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
  render();
  renderMap(pickHero(flights)); // the map only redraws when new data comes in
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

    // Save this phone's address so the server can reach it
    const json = subscription.toJSON();
    const { data: { user } } = await supabase.auth.getUser();
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
    await loadFlights();
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
