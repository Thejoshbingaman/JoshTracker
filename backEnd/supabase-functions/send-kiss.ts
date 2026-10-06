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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1. Who is sending the kiss? (read from their login token)
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) {
      return Response.json({ ok: false, error: "Not signed in" }, { status: 401, headers: cors });
    }
    const name = user.user_metadata?.name || "Someone special";

    // Which button: kiss, hug or punch (old app versions send nothing = kiss)
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }
    const MESSAGES: Record<string, { title: string; body: string }> = {
      kiss: { title: `${name} sent you a kiss ♥`, body: "Mwah." },
      hug: { title: `${name} sent you a hug`, body: "A long one. Squeeze back?" },
      punch: { title: `${name} punched you`, body: "Right in the arm. You probably deserved it." },
    };
    const type = MESSAGES[body.type] ? body.type : "kiss";
    const msg = MESSAGES[type];

    // 2. Send to everyone else's phones
    let { data: subs } = await admin.from("push_subscriptions").select("*").neq("user_id", user.id);
    let testMode = false;

    // While you're the only one with alerts on, send it to yourself so you can test
    if (!subs || subs.length === 0) {
      const mine = await admin.from("push_subscriptions").select("*").eq("user_id", user.id);
      subs = mine.data || [];
      testMode = true;
    }

    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({
            title: msg.title,
            body: testMode ? `${msg.body} (test: only you have alerts on)` : msg.body,
            tag: `ping-${type}-${Date.now()}`, // unique, so several in a row all show
          })
        );
        sent++;
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }

    return Response.json({ ok: true, sent, testMode }, { headers: cors });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers: cors });
  }
});
