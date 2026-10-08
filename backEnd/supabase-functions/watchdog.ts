// Watchdog: once a day, check that every part of JoshTracker is healthy.
// If anything is wrong, Josh gets one "JoshTracker check-up" alert listing the problems.
// Arc and Mom never see these.
//
// Test mode: send {"test": true} to get the report on your phone even when all is well.

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

const FLIGHTAWARE_MONTHLY_LIMIT = 400;   // free calls per month (see check-flights)
const WARN_AT = 0.8;                     // warn at 80% used
const hoursAgo = (t: string) => (Date.now() - new Date(t).getTime()) / 3600000;

async function checks() {
  const problems: string[] = [];
  const ok: string[] = [];

  // 1. Did the timers run? (each function writes a heartbeat when it finishes)
  const { data: beats } = await supabase.from("heartbeats").select("*");
  const beat = (n: string) => (beats || []).find((b: any) => b.name === n);
  const cf = beat("check-flights");
  if (!cf) problems.push("check-flights has never reported in");
  else if (hoursAgo(cf.last_ok) > 0.5) problems.push(`check-flights last ran ${Math.round(hoursAgo(cf.last_ok))} h ago (should be every 5 min)`);
  else ok.push("live checks running");
  const sp = beat("smart-processor");
  if (!sp) problems.push("daily calendar sync has never reported in");
  else if (hoursAgo(sp.last_ok) > 26) problems.push(`daily calendar sync last ran ${Math.round(hoursAgo(sp.last_ok))} h ago`);
  else ok.push("calendar sync ran today");

  // 2. Google: can we still get a calendar token?
  try {
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
    if (!data.access_token) problems.push(`Google calendar login failed (${data.error || res.status}): reconnect Google`);
    else ok.push("Google calendar login works");
  } catch (e) {
    problems.push(`Google calendar check failed: ${String(e)}`);
  }

  // 3. FlightAware budget this month
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { count: faCalls } = await supabase.from("api_calls").select("id", { count: "exact", head: true })
    .eq("api", "flightaware").gte("at", monthStart.toISOString());
  const used = faCalls || 0;
  if (used >= FLIGHTAWARE_MONTHLY_LIMIT * WARN_AT) {
    problems.push(`FlightAware: ${used} of ${FLIGHTAWARE_MONTHLY_LIMIT} free calls used this month`);
  } else ok.push(`FlightAware ${used}/${FLIGHTAWARE_MONTHLY_LIMIT} calls`);
  // Keep the log small
  await supabase.from("api_calls").delete().lt("at", new Date(Date.now() - 62 * 86400000).toISOString());

  // 4. Can Arc get alerts? (at least one phone that is not Josh's and not family)
  const adminId = Deno.env.get("ADMIN_USER_ID");
  const { data: users } = await supabase.auth.admin.listUsers();
  const family = new Set((users?.users || []).filter((u: any) => u.app_metadata?.role === "family").map((u: any) => u.id));
  const { data: subs } = await supabase.from("push_subscriptions").select("user_id");
  const arcPhones = (subs || []).filter((s: any) => s.user_id !== adminId && !family.has(s.user_id)).length;
  if (arcPhones === 0) problems.push("Arc has no phone with alerts on: she won't get flight alerts");
  else ok.push(`Arc alerts on (${arcPhones} phone${arcPhones > 1 ? "s" : ""})`);

  // 5. A flight in the air with stale data
  const { data: flights } = await supabase.from("flights").select("flightNumber, actualDepartureUtc, actualArrivalUtc, lastCheckedUtc, status");
  for (const f of flights || []) {
    const inAir = f.actualDepartureUtc && !f.actualArrivalUtc && !["Arrived", "Canceled", "Diverted"].includes(f.status);
    if (inAir && (!f.lastCheckedUtc || hoursAgo(f.lastCheckedUtc) > 1)) {
      problems.push(`${f.flightNumber} is in the air but its data is over an hour old`);
    }
  }

  return { problems, ok };
}

async function alertJosh(title: string, body: string) {
  const adminId = Deno.env.get("ADMIN_USER_ID");
  const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", adminId);
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body: body.slice(0, 300), tag: "watchdog" })
      );
    } catch { /* ignore */ }
  }
}

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* no body */ }
  try {
    const report = await checks();
    if (report.problems.length > 0) {
      await alertJosh("JoshTracker check-up: needs attention", report.problems.join("\n"));
    } else if (body.test) {
      await alertJosh("JoshTracker check-up: all good", report.ok.join(" · "));
    }
    return Response.json({ ok: true, ...report });
  } catch (err) {
    await alertJosh("JoshTracker check-up failed", String(err));
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
