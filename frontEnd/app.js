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

// "Sat, Oct 3 · 6:10 AM" in the airport's local time
function formatAt(utcTime, localString, withDay = true) {
  if (!utcTime) return "—";
  const d = toAirportClock(utcTime, localString);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  if (!withDay) return time;
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${day} · ${time}`;
}

// "Sat, Oct 3" in the airport's local time
function formatDay(utcTime, localString) {
  if (!utcTime) return "";
  return toAirportClock(utcTime, localString)
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// "2d 4h 12m", "1h 05m", or "12m 30s"
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
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

// Is the departure today or tomorrow, on the departure airport's clock?
function dayWord(f) {
  const depDay = toAirportClock(departureTime(f), f.departureLocal).toISOString().slice(0, 10);
  const today = toAirportClock(Date.now(), f.departureLocal);
  const todayKey = today.toISOString().slice(0, 10);
  const tomorrowKey = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
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
  const statusText = STATUS_TEXT[hero.status] || hero.status || "Scheduled";

  // Only show gate / baggage when we have them
  const extras = [];
  if (hero.departureGate) extras.push(`<div><span class="label">Gate</span><span class="time">${hero.departureGate}</span></div>`);
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
  const dayKey = (time) => new Date(time).toLocaleDateString("en-CA");
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
  const path = greatCirclePoints(from, to);
  const phase = phaseOf(hero);
  const split = Math.round(progressOf(hero) * (path.length - 1));

  // Full route (faint dashes) and the part already flown (bright)
  L.polyline(path, { color: "#ffffff", opacity: 0.3, weight: 2, dashArray: "4 6" }).addTo(mapLayers);
  if (split > 0) {
    L.polyline(path.slice(0, split + 1), { color: "#a78bfa", weight: 3 }).addTo(mapLayers);
  }

  // Airports
  L.marker(from, { icon: airportIcon(hero.origin), interactive: false }).addTo(mapLayers);
  L.marker(to, { icon: airportIcon(hero.destination), interactive: false }).addTo(mapLayers);

  // Plane: live position if we have it, otherwise an estimate from the schedule
  if (phase === "air") {
    const live = hero.lat != null && hero.lon != null;
    const pos = live ? [hero.lat, hero.lon] : path[split];
    const i = Math.min(split, path.length - 2);
    const heading = hero.heading ?? bearing(path[i], path[i + 1]);
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

async function loadFlights() {
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

// ---------- SEND A KISS ----------

const kissButton = document.getElementById("kiss-button");
const kissLabel = document.getElementById("kiss-label");

// Little hearts that float up from the button
function heartBurst() {
  const box = kissButton.getBoundingClientRect();
  for (let i = 0; i < 12; i++) {
    const h = document.createElement("span");
    h.className = "float-heart";
    h.textContent = "♥";
    h.style.left = `${box.left + box.width / 2 + (Math.random() - 0.5) * box.width * 0.8}px`;
    h.style.top = `${box.top + window.scrollY}px`;
    h.style.animationDelay = `${Math.random() * 0.3}s`;
    h.style.fontSize = `${14 + Math.random() * 16}px`;
    document.body.appendChild(h);
    setTimeout(() => h.remove(), 1800);
  }
}

kissButton.addEventListener("click", async () => {
  if (kissButton.disabled) return;
  kissButton.disabled = true;
  heartBurst();
  kissLabel.textContent = "Sending...";

  const { data, error } = await supabase.functions.invoke("send-kiss");

  if (error || !data?.ok) {
    kissLabel.textContent = "Didn't send. Try again";
  } else if (data.sent === 0) {
    kissLabel.textContent = "Sent, but no phones have alerts on";
  } else {
    kissLabel.textContent = "Kiss sent ♥";
  }

  // Short cooldown so it can't be spammed by accident
  setTimeout(() => {
    kissLabel.textContent = "Send a kiss";
    kissButton.disabled = false;
  }, 4000);
});

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
    refreshAlertsCard();
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

showCorrectView();
