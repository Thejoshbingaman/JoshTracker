import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

// Lets the website (a different address) call this function
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

const PER_MINUTE_LIMIT = 20;          // more than this in 60 seconds = refused
const MILESTONES = [50, 100];         // Arc's 50th and 100th of each button unlock a note

const MESSAGES: Record<string, (name: string) => { title: string; body: string }> = {
  kiss: (n) => ({ title: `${n} sent you a kiss ♥`, body: "Mwah." }),
  hug: (n) => ({ title: `${n} sent you a hug`, body: "A long one. Squeeze back?" }),
  punch: (n) => ({ title: `${n} punched you`, body: "Right in the arm. You probably deserved it." }),
};
const PLURAL: Record<string, string> = { kiss: "kisses", hug: "hugs", punch: "punches" };

// Family accounts (Mom) never get kisses, hugs, or punches
async function familyIds() {
  const { data } = await admin.auth.admin.listUsers();
  return new Set((data?.users || []).filter((u: any) => u.app_metadata?.role === "family").map((u: any) => u.id));
}

async function push(subs: any[], payload: any) {
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err: any) {
      // 404 / 410 = that phone turned alerts off; forget it
      if (err.statusCode === 404 || err.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1. Who is sending? (read from their login token)
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) {
      return Response.json({ ok: false, error: "Not signed in" }, { status: 401, headers: cors });
    }
    if (user.app_metadata?.role === "family") {
      return Response.json({ ok: false, error: "Not available" }, { status: 403, headers: cors });
    }
    const name = user.user_metadata?.name || "Someone special";
    const adminId = Deno.env.get("ADMIN_USER_ID");
    const isJosh = user.id === adminId;

    // Cashing in a milestone coupon: {"redeem": <milestone id>}
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }
    if (body.redeem) {
      const { data: used } = await admin.from("milestones")
        .update({ redeemed_at: new Date().toISOString() })
        .eq("id", body.redeem).not("unlocked_at", "is", null).not("coupon", "is", null).is("redeemed_at", null)
        .select("coupon, coupon_details").maybeSingle();
      if (!used) return Response.json({ ok: false, error: "Coupon not available" }, { status: 400, headers: cors });
      const { data: joshSubs } = await admin.from("push_subscriptions").select("*").eq("user_id", adminId);
      await push(joshSubs || [], {
        title: `${name} is cashing in a coupon`,
        body: `${used.coupon}. ${used.coupon_details || ""}`.trim(),
        tag: `coupon-${body.redeem}`,
      });
      return Response.json({ ok: true, redeemed: used }, { headers: cors });
    }

    // 2. Ping limit: a stuck button or a bug can't flood a phone
    const minuteAgo = new Date(Date.now() - 60000).toISOString();
    const { count: recent } = await admin.from("pings").select("id", { count: "exact", head: true })
      .eq("sender_id", user.id).gte("created_at", minuteAgo);
    if ((recent || 0) >= PER_MINUTE_LIMIT) {
      return Response.json({ ok: false, error: "Slow down" }, { status: 429, headers: cors });
    }

    // 3. Which button (old app versions send nothing = kiss)
    const type = MESSAGES[body.type] ? body.type : "kiss";
    const msg = MESSAGES[type](name);

    // 4. Count it on the scoreboard
    await admin.from("pings").insert({ sender_id: user.id, sender_name: name, type });

    // 5. Send to the partner's phones only (never to the sender, never to family)
    const family = await familyIds();
    const { data: all } = await admin.from("push_subscriptions").select("*");
    let subs = (all || []).filter((s: any) => s.user_id !== user.id && !family.has(s.user_id));
    let testMode = false;
    if (subs.length === 0) {
      // While you're the only one with alerts on, send it to yourself so you can test
      subs = (all || []).filter((s: any) => s.user_id === user.id);
      testMode = true;
    }
    const sent = await push(subs, {
      title: msg.title,
      body: testMode ? `${msg.body} (test: only you have alerts on)` : msg.body,
      tag: `ping-${type}-${Date.now()}`, // unique, so several in a row all show
    });

    // 6. Milestones: Arc's 50th / 100th of this button unlocks Josh's note.
    //    "At or past" the count, so a note is never skipped if she was already past it.
    let milestone: any = null;
    if (!isJosh) {
      const { count: total } = await admin.from("pings").select("id", { count: "exact", head: true })
        .eq("sender_id", user.id).eq("type", type);
      const { data: unlocked } = await admin.from("milestones")
        .update({ unlocked_at: new Date().toISOString() })
        .eq("type", type).lte("count", total || 0).is("unlocked_at", null)
        .select("id, type, count, title, note, coupon, coupon_details");
      if (unlocked && unlocked.length) {
        unlocked.sort((a: any, b: any) => a.count - b.count);
        milestone = unlocked[0];          // the app shows this one, then any others in a row
        const joshSubs = (all || []).filter((s: any) => s.user_id === adminId);
        await push(joshSubs, {
          title: `${name} just hit ${unlocked[unlocked.length - 1].count} ${PLURAL[type]}`,
          body: "Your note just opened on her phone.",
          tag: `milestone-${type}`,
        });
      }
    }

    return Response.json({ ok: true, sent, testMode, milestone }, { headers: cors });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers: cors });
  }
});
