import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

const HOME_AIRPORTS = ["BWI", "MDT", "PHL"];
const CITY: Record<string, string> = {
  BWI: "Baltimore", MDT: "Harrisburg", PHL: "Philadelphia", LAX: "Los Angeles",
  STL: "St. Louis", MDW: "Chicago", DEN: "Denver", DAL: "Dallas", HOU: "Houston",
  PHX: "Phoenix", LAS: "Las Vegas", MCO: "Orlando", TPA: "Tampa", BNA: "Nashville",
  ATL: "Atlanta", SAN: "San Diego", AUS: "Austin", MSY: "New Orleans",
  FLL: "Fort Lauderdale", MCI: "Kansas City", SAT: "San Antonio", SEA: "Seattle",
};
const city = (code: string) => CITY[code] || code;

// ================= TIME HELPERS =================

// How many minutes from now until a time (negative = in the past)
function minutesUntil(time: string) {
  return (new Date(time).getTime() - Date.now()) / 60000;
}

// "-04:00" at the end of "2026-10-03 06:10-04:00", as minutes (-240)
function offsetMinutes(localString: string) {
  if (!localString) return 0;
  const off = localString.slice(-6);
  const sign = off[0] === "-" ? -1 : 1;
  return sign * (parseInt(off.slice(1, 3)) * 60 + parseInt(off.slice(4, 6)));
}

// Alert times are shown on HER clock (Eastern), not the airport's
const ALERT_TIME_ZONE = "America/New_York";
function localTime(utcTime: string, _localString?: string) {
  return new Date(utcTime).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: ALERT_TIME_ZONE,
  });
}

// "Sun 9:50 PM" on her clock (used when the day could be confusing)
function dayAndTime(utcTime: string) {
  const day = new Date(utcTime).toLocaleDateString("en-US", { weekday: "short", timeZone: ALERT_TIME_ZONE });
  return `${day} ${localTime(utcTime)}`;
}

// Best known times
const departureTime = (f: any) => f.actualDepartureUtc || f.revisedDepartureUtc || f.departureUtc;
const arrivalTime = (f: any) =>
  f.actualArrivalUtc || f.revisedArrivalUtc || f.predictedArrivalUtc || f.arrivalUtc;

// ================= LIVE CHECKS (same as before) =================

function shouldCheck(f: any) {
  if (["Arrived", "Canceled", "Diverted"].includes(f.status)) return false;
  const toDeparture = minutesUntil(f.revisedDepartureUtc || f.departureUtc);
  const toArrival = minutesUntil(f.revisedArrivalUtc || f.predictedArrivalUtc || f.arrivalUtc);
  if (toDeparture > 180 || toArrival < -120) return false;
  const sinceLastCheck = f.lastCheckedUtc ? -minutesUntil(f.lastCheckedUtc) : 9999;
  const nearEvent = Math.abs(toDeparture) <= 60 || Math.abs(toArrival) <= 60;
  return sinceLastCheck >= (nearEvent ? 9 : 29);
}

async function checkFlight(f: any) {
  const now = new Date().toISOString();
  const res = await fetch(
    `https://aerodatabox.p.rapidapi.com/flights/number/${f.flightNumber}/${f.date}?withLocation=true`,
    {
      headers: {
        "X-RapidAPI-Key": Deno.env.get("AERODATABOX_API_KEY")!,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    }
  );
  const text = res.ok ? await res.text() : "";
  const segments = text ? JSON.parse(text) : [];
  const seg = segments.find((s: any) => s.departure.airport.iata === f.origin);

  if (!seg) {
    await supabase.from("flights").update({ lastCheckedUtc: now }).eq("id", f.id);
    return `${f.flightNumber}: no live data (HTTP ${res.status})`;
  }

  const { error } = await supabase.from("flights").update({
    status: seg.status,
    lastCheckedUtc: now,
    revisedDepartureUtc: seg.departure.revisedTime?.utc || null,
    actualDepartureUtc: seg.departure.runwayTime?.utc || null,
    predictedArrivalUtc: seg.arrival.predictedTime?.utc || null,
    predictedArrivalLocal: seg.arrival.predictedTime?.local || null,
    revisedArrivalUtc: seg.arrival.revisedTime?.utc || null,
    actualArrivalUtc: seg.arrival.runwayTime?.utc || null,
    departureGate: seg.departure.gate || null,
    arrivalGate: seg.arrival.gate || null,
    baggageBelt: seg.arrival.baggageBelt || null,
    lat: seg.location?.lat ?? null,
    lon: seg.location?.lon ?? null,
    altitudeFt: seg.location?.pressureAltitude?.feet ?? null,
    heading: seg.location?.trueTrack?.deg ?? null,
  }).eq("id", f.id);

  if (error) return `${f.flightNumber}: database error: ${error.message}`;
  return `${f.flightNumber}: ${seg.status}`;
}

// ================= ALERTS =================

// Send one alert to every phone that turned alerts on
async function sendToAll(payload: any) {
  const { data: subs } = await supabase.from("push_subscriptions").select("*");
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err: any) {
      // 404 / 410 = that phone turned alerts off; forget it
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }
  return sent;
}

// Decide which alert (if any) this flight needs right now
async function alertsFor(f: any) {
  const log: string[] = [];
  const flags: any = {};
  const status = f.status || "";
  const landed = status === "Arrived" || !!f.actualArrivalUtc;
  const inAir = !landed && (["Departed", "EnRoute", "Approaching"].includes(status) || !!f.actualDepartureUtc);
  const dest = city(f.destination);
  const goingHome = HOME_AIRPORTS.includes(f.destination);

  async function send(flag: string, title: string, body: string) {
    await sendToAll({ title, body, tag: `${f.flightNumber}-${f.date}` });
    flags[flag] = true;
    log.push(`${f.flightNumber}: sent "${title}"`);
  }

  // 1. Canceled
  if ((status === "Canceled" || status === "CanceledUncertain") && !f.notifiedCanceled) {
    await send("notifiedCanceled", "Josh's flight was canceled",
      `${f.flightNumber} ${f.origin} → ${f.destination}. He'll share a new plan soon.`);
  }

  // 2. Flight tomorrow: at 7 PM HER time (Eastern) the evening before his departure day
  if (!f.notifiedTomorrow && !inAir && !landed) {
    const [y, m, d] = f.departureLocal.slice(0, 10).split("-").map(Number); // his departure date, airport time
    const now = new Date();
    const etOffset = (Date.parse(now.toLocaleString("en-US", { timeZone: "UTC" })) -
      Date.parse(now.toLocaleString("en-US", { timeZone: ALERT_TIME_ZONE }))) / 60000; // 240 in summer, 300 in winter
    const sevenPmBefore = Date.UTC(y, m - 1, d - 1, 19, 0) + etOffset * 60000;
    const toDeparture = minutesUntil(departureTime(f));
    if (Date.now() >= sevenPmBefore && toDeparture > 120) {
      await send("notifiedTomorrow", "Josh flies tomorrow",
        `${f.origin} → ${f.destination}, ${dayAndTime(departureTime(f))} your time. Flight ${f.flightNumber}.`);
    }
  }

  // 2b. Boarding: about 35 minutes before departure (or when the airline says "Boarding")
  if (!f.notifiedBoarding && !inAir && !landed && !["Canceled", "CanceledUncertain", "Diverted"].includes(status)) {
    const toDeparture = minutesUntil(departureTime(f));
    if (status === "Boarding" || (toDeparture <= 35 && toDeparture > -15)) {
      await send("notifiedBoarding", "Josh is boarding",
        `Flight ${f.flightNumber} to ${dest} leaves at ${localTime(departureTime(f))}.`);
    }
  }

  // 3. Delayed by 15+ minutes (and again if it gets 15+ minutes worse)
  if (!inAir && !landed && f.revisedDepartureUtc) {
    const delay = Math.round((new Date(f.revisedDepartureUtc).getTime() - new Date(f.departureUtc).getTime()) / 60000);
    if (delay >= 15 && delay - (f.notifiedDelayMinutes || 0) >= 15) {
      await sendToAll({
        title: "Josh's flight is delayed",
        body: `${f.flightNumber} now leaves at ${localTime(f.revisedDepartureUtc, f.departureLocal)} (${delay} min late).`,
        tag: `${f.flightNumber}-${f.date}`,
      });
      flags.notifiedDelayMinutes = delay;
      log.push(`${f.flightNumber}: sent delay ${delay} min`);
    }
  }

  // 4. Departed
  if ((inAir || landed) && !f.notifiedDeparted) {
    if (landed) {
      flags.notifiedDeparted = true; // too late to matter; skip it
    } else {
      flags.notifiedBoarding = true; // no boarding alert after he's already left
      await send("notifiedDeparted", "Josh is on his way",
        `His plane left the gate. Lands in ${dest} around ${localTime(arrivalTime(f))}.`);
    }
  }

  // 5. Landing in about 10 minutes
  if (inAir && !f.notifiedLanding) {
    const toArrival = minutesUntil(arrivalTime(f));
    if (toArrival <= 12 && toArrival > -5) {
      await send("notifiedLanding", goingHome ? "Josh is almost home" : "Josh lands in about 10 minutes",
        `Arriving in ${dest} at ${localTime(arrivalTime(f), f.arrivalLocal)}.`);
    }
  }

  // 6. Landed
  if (landed && !f.notifiedLanded) {
    flags.notifiedLanding = true;
    await send("notifiedLanded", goingHome ? "Josh is home!" : "Josh has landed",
      `Landed in ${dest} at ${localTime(arrivalTime(f), f.arrivalLocal)}.`);
  }

  if (Object.keys(flags).length > 0) {
    await supabase.from("flights").update(flags).eq("id", f.id);
  }
  return log;
}

// ================= MAIN =================

Deno.serve(async (req) => {
  try {
    // Test mode: send {"test": true} to get a test alert
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }
    if (body.test) {
      const sent = await sendToAll({ title: "JoshTracker test", body: "Alerts are working.", tag: "test" });
      return Response.json({ ok: true, message: `Test alert sent to ${sent} device(s)` });
    }

    // 1. Live checks for flights that are close
    const { data: before, error } = await supabase.from("flights").select("*");
    if (error) throw error;
    const results: string[] = [];
    for (const f of (before || []).filter(shouldCheck)) {
      results.push(await checkFlight(f));
    }

    // 2. Alerts, using the freshest data
    const { data: after } = await supabase.from("flights").select("*");
    for (const f of after || []) {
      results.push(...(await alertsFor(f)));
    }

    return Response.json({ ok: true, results });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
