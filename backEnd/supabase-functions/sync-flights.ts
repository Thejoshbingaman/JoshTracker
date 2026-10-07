// This is a copy of the "smart-processor" Edge Function in Supabase.
// It runs once a day: reads Google Calendar, looks up each flight, saves it.
// If you change it in Supabase, paste the new version here too.

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

// Send a "something went wrong" alert to Josh's phones only
async function alertJosh(message: string) {
  const adminId = Deno.env.get("ADMIN_USER_ID");
  if (!adminId) return;
  const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", adminId);
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "JoshTracker problem", body: message.slice(0, 200), tag: "admin" })
      );
    } catch { /* ignore */ }
  }
}

// STEP 1: Use the saved Google refresh token to get a short-lived access token
async function getGoogleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Google login failed: " + (data.error || "unknown"));
  }
  return data.access_token;
}

// STEP 2: Get your upcoming calendar events
async function getCalendarEvents(accessToken: string) {
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: "50",
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + params,
    { headers: { Authorization: "Bearer " + accessToken } }
  );
  const data = await res.json();
  return data.items || [];
}

// STEP 3: Pull the flight number, origin airport, and date out of an event
function parseFlightEvent(event: any) {
  const summary = event.summary || "";
  const location = event.location || "";
  const startTime = event.start?.dateTime;

  const date = startTime ? startTime.split("T")[0] : null;

  const numberMatch = summary.match(/\(([A-Z]{2})\s?(\d{2,4})\)/);
  const flightNumber = numberMatch ? numberMatch[1] + numberMatch[2] : null;

  const originMatch = location.match(/([A-Z]{3})$/);
  const originCode = originMatch ? originMatch[1] : null;

  return { flightNumber, originCode, date, summary };
}

// STEP 4: Look up the flight on AeroDataBox and save it
async function lookupAndSave(flight: any) {
  const res = await fetch(
    `https://aerodatabox.p.rapidapi.com/flights/number/${flight.flightNumber}/${flight.date}`,
    {
      headers: {
        "X-RapidAPI-Key": Deno.env.get("AERODATABOX_API_KEY")!,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    }
  );

  if (!res.ok) {
    return `${flight.flightNumber}: AeroDataBox error ${res.status}`;
  }

  const text = await res.text();
  const segments = text ? JSON.parse(text) : [];

  const seg = segments.find((s: any) => s.departure.airport.iata === flight.originCode);
  if (!seg) {
    return `${flight.flightNumber}: no segment departs from ${flight.originCode}`;
  }

  const { error } = await supabase.from("flights").upsert(
    {
      flightNumber: flight.flightNumber,
      date: seg.departure.scheduledTime.local.split(" ")[0],
      origin: seg.departure.airport.iata,
      destination: seg.arrival.airport.iata,
      originLat: seg.departure.airport.location?.lat ?? null,
      originLon: seg.departure.airport.location?.lon ?? null,
      destinationLat: seg.arrival.airport.location?.lat ?? null,
      destinationLon: seg.arrival.airport.location?.lon ?? null,
      departureUtc: seg.departure.scheduledTime.utc,
      departureLocal: seg.departure.scheduledTime.local,
      arrivalUtc: seg.arrival.scheduledTime.utc,
      arrivalLocal: seg.arrival.scheduledTime.local,
      predictedArrivalUtc: seg.arrival.predictedTime?.utc || null,
      predictedArrivalLocal: seg.arrival.predictedTime?.local || null,
      status: seg.status,
      aircraft: seg.aircraft?.model || null,
      airline: seg.airline?.name || null,
      lastUpdatedUtc: seg.lastUpdatedUtc,
    },
    { onConflict: "flightNumber,date" }
  );

  if (error) {
    return `${flight.flightNumber}: database error: ${error.message}`;
  }
  return `${flight.flightNumber}: saved (${seg.departure.airport.iata} to ${seg.arrival.airport.iata})`;
}

// ================= HOTEL STAYS =================
// Hotel bookings from Gmail are ALL-DAY events:
//   Title:    "Stay at DoubleTree by Hilton Hotel Reading"
//   Location: "701 Penn Street, Reading, PA 19601, USA"
//   Start:    { date: "2026-10-06" }   (check-in day)
//   End:      { date: "2026-10-09" }   (the day AFTER check-out: Google end dates are exclusive)
// So we add the usual hotel times: check-in 3 PM, check-out 11 AM, in the hotel's time zone.

const STATE_TZ: Record<string, string> = {
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", IN: "America/Indiana/Indianapolis", KY: "America/New_York", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", NH: "America/New_York",
  NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York", OH: "America/New_York",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Boise", MT: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu",
};

// "2026-10-06" + 15 (3 PM) in a time zone → UTC ISO string
function localToUtc(day: string, hour: number, tz: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0);
  const asUtc = Date.parse(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  const asZone = Date.parse(new Date(guess).toLocaleString("en-US", { timeZone: tz }));
  return new Date(guess + (asUtc - asZone)).toISOString();
}

// "2026-10-09" → "2026-10-08"
function dayBefore(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function parseStayEvent(event: any) {
  const hotel = (event.summary || "").replace(/^Stay at\s+/i, "").trim();
  const location = (event.location || "").replace(/\n/g, ", ");
  const parts = location.split(",").map((p: string) => p.trim()).filter(Boolean);
  // Find the "PA 19601" part; the city is the part just before it
  const i = parts.findIndex((p: string) => /^[A-Z]{2}\s+\d{5}/.test(p));
  const city = i > 0 ? parts[i - 1] : null;
  const state = i > 0 ? parts[i].slice(0, 2) : null;
  const address = i > 0 ? parts.slice(Math.max(0, i - 2), i + 1).join(", ") : location;
  const tz = (state && STATE_TZ[state]) || "America/New_York";

  // Timed event: use its times. All-day event: 3 PM check-in, 11 AM check-out.
  const checkIn = event.start?.dateTime || (event.start?.date ? localToUtc(event.start.date, 15, tz) : null);
  const checkOut = event.end?.dateTime || (event.end?.date ? localToUtc(dayBefore(event.end.date), 11, tz) : null);

  return { eventId: event.id, hotel, address, city, state, checkIn, checkOut };
}

// Address to [lat, lon] with OpenStreetMap (free, no key). Once per new hotel.
async function geocode(query: string) {
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?" +
        new URLSearchParams({ q: query, format: "json", limit: "1", countrycodes: "us" }),
      { headers: { "User-Agent": "JoshTracker/1.0 (personal flight tracker)" } }
    );
    const data = await res.json();
    if (data?.[0]) return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  } catch { /* fall through */ }
  return { lat: null, lon: null };
}

async function syncStays(events: any[]) {
  const results: string[] = [];
  const stayEvents = events.filter((e: any) => /^Stay at /i.test(e.summary || ""));
  const { data: saved } = await supabase.from("stays").select("event_id, address, lat, lon");

  for (const e of stayEvents) {
    const s = parseStayEvent(e);
    if (!s.checkIn || !s.checkOut || !s.city) {
      // Show exactly what Google sent, so the parser can be fixed
      const raw = JSON.stringify({ location: e.location ?? null, start: e.start ?? null, end: e.end ?? null, eventType: e.eventType ?? null });
      results.push(`could not read hotel event "${e.summary}": ${raw}`);
      continue;
    }
    // Reuse the saved location if the address did not change
    const old = (saved || []).find((r: any) => r.event_id === s.eventId);
    let where = { lat: null as number | null, lon: null as number | null };
    if (old && old.address === s.address && old.lat != null) {
      where = { lat: old.lat, lon: old.lon };
    } else {
      where = await geocode(s.address);                                    // the street address
      if (where.lat == null) where = await geocode(`${s.city}, ${s.state}`); // or just the city
    }

    const { error } = await supabase.from("stays").upsert(
      {
        event_id: s.eventId,
        hotel: s.hotel,
        address: s.address,
        city: s.city,
        state: s.state,
        lat: where.lat,
        lon: where.lon,
        check_in: s.checkIn,
        check_out: s.checkOut,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id" }
    );
    results.push(error ? `stay ${s.city}: database error: ${error.message}` : `stay ${s.city}: saved`);
  }

  // A future stay that is no longer in the calendar was canceled: remove it.
  // (Only when the calendar answered, so a Google hiccup never wipes the list.)
  if (events.length > 0) {
    const ids = stayEvents.map((e: any) => `"${e.id}"`).join(",");
    let q = supabase.from("stays").delete().gt("check_out", new Date().toISOString());
    if (ids) q = q.not("event_id", "in", `(${ids})`);
    await q;
  }
  // Stays that ended more than 24 hours ago
  await supabase.from("stays").delete().lt("check_out", new Date(Date.now() - 86400000).toISOString());
  return results;
}

// MAIN
Deno.serve(async (req) => {
  // Test mode: send {"testAlert": true} to check that problem alerts reach your phone
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }
  if (body.testAlert) {
    await alertJosh("Test: problem alerts are working.");
    return Response.json({ ok: true, message: "Test problem alert sent" });
  }

  try {
    const accessToken = await getGoogleAccessToken();
    const events = await getCalendarEvents(accessToken);

    const parsed = events
      .filter((e: any) => e.summary && e.summary.startsWith("Flight"))
      .map(parseFlightEvent);

    const flights = parsed.filter((f: any) => f.flightNumber && f.originCode && f.date);
    const unreadable = parsed.filter((f: any) => !(f.flightNumber && f.originCode && f.date));

    // Save API calls: a flight that is already saved and more than 2 days away
    // is skipped. It gets refreshed daily once it is within 2 days.
    const { data: saved } = await supabase.from("flights").select("flightNumber, date, departureUtc");
    const results: string[] = [];
    for (const flight of flights) {
      const match = (saved || []).find((r: any) =>
        r.flightNumber === flight.flightNumber &&
        Math.abs(new Date(r.date).getTime() - new Date(flight.date).getTime()) <= 86400000
      );
      const farAway = match && new Date(match.departureUtc).getTime() - Date.now() > 2 * 86400000;
      if (farAway) {
        results.push(`${flight.flightNumber}: saved (up to date, no API call)`);
      } else {
        results.push(await lookupAndSave(flight));
      }
    }

    // Hotel stays from the same calendar events (no paid API calls)
    results.push(...(await syncStays(events)));

    // Delete flights that landed more than 24 hours ago
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("flights").delete().lt("arrivalUtc", cutoff);

    // Anything that did not save, or a calendar event we could not read = a problem
    const problems = results.filter((r) => !r.includes(": saved"));
    for (const u of unreadable) problems.push(`could not read calendar event "${u.summary}"`);
    if (problems.length > 0) {
      await alertJosh("Daily sync: " + problems.join("; "));
    }

    return Response.json({ ok: true, results, problems });
  } catch (err) {
    await alertJosh("Daily sync failed: " + String(err));
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
