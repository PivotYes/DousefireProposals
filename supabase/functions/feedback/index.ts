// Supabase Edge Function: feedback
// Saves feedback from the Proposal Builder and emails it to the office.
// Secrets (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY  - from resend.com (required to send the email)
//   FEEDBACK_TO     - where it goes, e.g. office@pivotyes.com (comma-separate for more than one)
//   FEEDBACK_FROM   - optional sender, e.g. "Proposal Builder <app@dousefire.co>" once the domain is verified in Resend.
//                     Leave it out to use Resend's test sender (only delivers to the email on your Resend account).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const KINDS: Record<string, string> = { problem: "Problem", change: "Change request", idea: "Idea" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: ok, error } = await sb.rpc("is_team");
    if (error || !ok) return json({ error: "not_on_team" }, 403);
    const { data: { user } } = await sb.auth.getUser();
    const email = String(user?.email || "").toLowerCase();

    const body = await req.json();
    const kind = KINDS[body.kind] ? body.kind : "problem";
    const message = String(body.message || "").trim().slice(0, 5000);
    if (!message) return json({ error: "empty" }, 400);
    const ctx = body.context && typeof body.context === "object" ? body.context : {};
    const name = String(body.name || "").slice(0, 120);

    // 1. Save it, so nothing is lost even if the email fails
    const { error: insErr } = await sb.from("feedback").insert({
      email, name, kind, message, context: ctx, user_agent: String(req.headers.get("user-agent") || "").slice(0, 300),
    });
    const saved = !insErr;

    // 2. Email the office
    const key = Deno.env.get("RESEND_API_KEY"), to = Deno.env.get("FEEDBACK_TO");
    if (!key || !to) return json({ ok: saved, emailed: false, error: saved ? undefined : "save_failed" }, saved ? 200 : 500);
    const from = Deno.env.get("FEEDBACK_FROM") || "Dousefire Proposal Builder <onboarding@resend.dev>";
    const who = name ? `${name} (${email})` : email;
    const first = message.split("\n")[0].slice(0, 60);
    const rows = Object.entries(ctx).filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#5A6676">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#14202E">
      <p><b>${esc(KINDS[kind])}</b> from ${esc(who)}</p>
      <div style="white-space:pre-wrap;background:#F3F5F7;border-radius:8px;padding:12px">${esc(message)}</div>
      ${rows ? `<p style="margin-top:16px;color:#5A6676">Where they were</p><table style="font-size:13px">${rows}</table>` : ""}
      <p style="color:#5A6676;font-size:12px;margin-top:16px">Reply to this email to answer ${esc(name || email)} directly.</p></div>`;
    const text = `${KINDS[kind]} from ${who}\n\n${message}\n\n` + Object.entries(ctx).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${v}`).join("\n");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: to.split(",").map((s) => s.trim()).filter(Boolean), reply_to: email || undefined,
        subject: `[Proposal Builder] ${KINDS[kind]}: ${first}`, html, text,
      }),
    });
    const emailed = r.ok;
    if (!saved && !emailed) return json({ error: "send_failed", detail: await r.text().catch(() => "") }, 502);
    return json({ ok: true, saved, emailed });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
