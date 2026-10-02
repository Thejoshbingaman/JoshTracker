// This is a copy of the "smart-processor" Edge Function in Supabase.
// It runs once a day: reads Google Calendar, looks up each flight, saves it.
// If you change it in Supabase, paste the new version here too.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

  return { flightNumber, originCode, date };
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

// MAIN
Deno.serve(async () => {
  try {
    const accessToken = await getGoogleAccessToken();
    const events = await getCalendarEvents(accessToken);

    const flights = events
      .filter((e: any) => e.summary && e.summary.startsWith("Flight"))
      .map(parseFlightEvent)
      .filter((f: any) => f.flightNumber && f.originCode && f.date);

    const results = [];
    for (const flight of flights) {
      results.push(await lookupAndSave(flight));
    }

    // Delete flights that landed more than 24 hours ago
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("flights").delete().lt("arrivalUtc", cutoff);

    return Response.json({ ok: true, results });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
