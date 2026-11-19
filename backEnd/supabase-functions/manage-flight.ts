// manage-flight: Josh fixes his flights from the app, when the calendar is wrong.
//   {"hide": 12}                                   remove a flight from the app (no more alerts). The calendar can't bring it back.
//   {"unhide": 12}                                 put a removed flight back
//   {"add": {"flightNumber": "WN1234", "date": "2026-11-20", "origin": "BWI"}, "replaces": 12}
//                                                  add a flight by hand (looked up like a calendar flight).
//                                                  "replaces" (optional) removes the old flight at the same time.
// Only Josh (ADMIN_USER_ID) can use it.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const reply = (body: any, status = 200) => Response.json(body, { status, headers: cors });

// Look up the flight on AeroDataBox (the same lookup the calendar sync uses) and save it
async function addFlight(flightNumber: string, date: string, origin: string) {
  const res = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${date}`, {
    headers: {
      "X-RapidAPI-Key": Deno.env.get("AERODATABOX_API_KEY")!,
      "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
    },
  });
  if (!res.ok) throw new Error(`Flight lookup failed (${res.status}). Check the flight number and date.`);
  const text = await res.text();
  const segments = text ? JSON.parse(text) : [];
  if (!segments.length) throw new Error(`No flight ${flightNumber} found on ${date}.`);
  const seg = origin
    ? segments.find((s: any) => s.departure.airport.iata === origin)
    : segments[0];
  if (!seg) {
    const from = segments.map((s: any) => s.departure.airport.iata).join(", ");
    throw new Error(`${flightNumber} on ${date} does not leave from ${origin}. It leaves from: ${from}.`);
  }
  const row = {
    flightNumber,
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
    manual: true,       // the calendar sync never removes it
    hidden: false,
  };
  const { data, error } = await admin.from("flights").upsert(row, { onConflict: "flightNumber,date" }).select("id").single();
  if (error) throw new Error("Database error: " + error.message);
  return { id: data.id, route: `${row.origin} → ${row.destination}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user || user.id !== Deno.env.get("ADMIN_USER_ID")) return reply({ ok: false, error: "Only Josh can change flights" }, 403);

    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }

    if (body.hide || body.unhide) {
      const { error } = await admin.from("flights").update({ hidden: !!body.hide }).eq("id", body.hide || body.unhide);
      if (error) return reply({ ok: false, error: error.message }, 400);
      return reply({ ok: true });
    }

    if (body.add) {
      const flightNumber = String(body.add.flightNumber || "").toUpperCase().replace(/\s+/g, "");
      const date = String(body.add.date || "");
      const origin = String(body.add.origin || "").toUpperCase().trim();
      if (!/^[A-Z0-9]{2}\d{1,4}$/.test(flightNumber)) return reply({ ok: false, error: "Flight number looks wrong. Example: WN1234" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply({ ok: false, error: "Pick a date" }, 400);
      if (origin && !/^[A-Z]{3}$/.test(origin)) return reply({ ok: false, error: "Airport should be 3 letters. Example: BWI" }, 400);
      const saved = await addFlight(flightNumber, date, origin);
      if (body.replaces && String(body.replaces) !== String(saved.id)) {
        await admin.from("flights").update({ hidden: true }).eq("id", body.replaces);
      }
      return reply({ ok: true, ...saved });
    }

    return reply({ ok: false, error: "Nothing to do" }, 400);
  } catch (err) {
    return reply({ ok: false, error: String((err as Error).message || err) }, 500);
  }
});
