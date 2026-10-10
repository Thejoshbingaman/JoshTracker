// Sunday preview: every Sunday at 7 PM Eastern, tell Arc where Josh will be this week.
//
// Cron calls this function every hour on Sundays and Mondays (UTC).
// It only sends when it is Sunday, 7 PM in New York, so daylight saving never breaks it.
//
// Test modes (send as the request body):
//   {"preview": true}  = return the message, send nothing
//   {"test": true}     = send it to Josh's phones only
//   {"force": true}    = send it to Arc now, whatever the time

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

const TZ = "America/New_York";
const HOME_AIRPORTS = ["BWI", "MDT", "PHL"];
const CITY: Record<string, string> = {
  BWI: "Baltimore", MDT: "Harrisburg", PHL: "Philadelphia", LAX: "Los Angeles",
  STL: "St. Louis", MDW: "Chicago", DEN: "Denver", DAL: "Dallas", HOU: "Houston",
  PHX: "Phoenix", LAS: "Las Vegas", MCO: "Orlando", TPA: "Tampa", BNA: "Nashville",
  ATL: "Atlanta", SAN: "San Diego", AUS: "Austin", MSY: "New Orleans",
  FLL: "Fort Lauderdale", MCI: "Kansas City", SAT: "San Antonio", SEA: "Seattle",
  CHS: "Charleston", GSP: "Greenville", CAE: "Columbia", MYR: "Myrtle Beach", RDU: "Raleigh", CLT: "Charlotte",
  ISP: "Long Island", LGA: "New York", EWR: "Newark", BOS: "Boston", PIT: "Pittsburgh", CLE: "Cleveland",
};
const city = (code: string) => CITY[code] || code;

// ---------- time helpers (all in Eastern) ----------
const dayKey = (t: string | number | Date) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
const dow = (t: string | number | Date) => new Date(t).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
const clock = (t: string) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const etHour = () => Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ }));
const isSundayET = () => dow(Date.now()) === "Sun";

// ---------- build the message ----------
async function buildPreview() {
  const { data: flights } = await supabase.from("flights").select("*").order("departureUtc");
  const { data: stays } = await supabase.from("stays").select("*").order("check_in");

  // The 7 days from tomorrow (Monday) through next Sunday, at midday to dodge DST edges
  const days: { key: string; name: string }[] = [];
  for (let i = 1; i <= 7; i++) {
    const t = Date.now() + i * 86400000;
    days.push({ key: dayKey(t), name: dow(t) });
  }

  const depTime = (f: any) => f.revisedDepartureUtc || f.departureUtc;
  const upcoming = (flights || []).filter((f: any) => dayKey(depTime(f)) >= days[0].key);
  const flightLines: string[] = [];

  // Where is Josh each day? Flights first, then hotel nights (check-in day through check-out day), else home.
  let where = upcoming.length && !HOME_AIRPORTS.includes(upcoming[0].origin) ? city(upcoming[0].origin) : "home";
  const place: string[] = [];
  for (const d of days) {
    const todays = upcoming.filter((f: any) => dayKey(depTime(f)) === d.key);
    const stay = (stays || []).find((s: any) => dayKey(s.check_in) <= d.key && d.key <= dayKey(s.check_out));
    if (todays.length) {
      for (const f of todays) {
        const to = HOME_AIRPORTS.includes(f.destination) ? "home" : `to ${city(f.destination)}`;
        flightLines.push(`${d.name}: flies ${to} at ${clock(depTime(f))}`);
      }
      const last = todays[todays.length - 1];
      where = HOME_AIRPORTS.includes(last.destination) ? "home" : city(last.destination);
      place.push(stay ? stay.city : where);
    } else if (stay) {
      place.push(stay.city);
    } else {
      place.push(where);
    }
  }

  // Merge days in a row at the same place: "Mon–Thu Garden City"
  const spans: string[] = [];
  for (let i = 0; i < 7; ) {
    let j = i;
    while (j + 1 < 7 && place[j + 1] === place[i]) j++;
    const range = i === j ? days[i].name : `${days[i].name}–${days[j].name}`;
    spans.push(`${range}: ${place[i] === "home" ? "home" : place[i]}`);
    i = j + 1;
  }

  const allHome = place.every((p) => p === "home");
  const title = allHome ? "Josh is home all week" : "Josh's week";
  const body = allHome
    ? "No trips on the calendar this week."
    : [spans.join(" · "), ...flightLines].join("\n");
  return { title, body };
}

// ---------- send ----------
async function send(payload: any, onlyJosh: boolean) {
  const { data: all } = await supabase.from("push_subscriptions").select("*");
  const adminId = Deno.env.get("ADMIN_USER_ID");
  const mine = (all || []).filter((s: any) => s.user_id === adminId);
  const { data: users } = await supabase.auth.admin.listUsers();
  const family = new Set((users?.users || []).filter((u: any) => u.app_metadata?.role === "family").map((u: any) => u.id));
  const others = (all || []).filter((s: any) => s.user_id !== adminId && !family.has(s.user_id));
  const subs = onlyJosh ? mine : (others.length ? others : all || []);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err: any) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }

  try {
    const msg = await buildPreview();
    if (body.preview) return Response.json({ ok: true, ...msg });

    const onTime = isSundayET() && etHour() === 19;
    if (!body.test && !body.force && !onTime) {
      return Response.json({ ok: true, skipped: "not Sunday 7 PM Eastern" });
    }
    const sent = await send({ ...msg, tag: "weekly-preview" }, !!body.test);
    return Response.json({ ok: true, sent, ...msg });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
