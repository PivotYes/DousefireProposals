// Supabase Edge Function: qbo-callback
// Intuit sends the admin back here after they approve the QuickBooks connection.
// IMPORTANT: turn OFF "Verify JWT" for this function (Intuit can't send a Supabase sign-in token).
// Secrets used: QBO_CLIENT_ID, QBO_CLIENT_SECRET, optional QBO_ENV (sandbox | production), optional APP_URL.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ENV = (Deno.env.get("QBO_ENV") || "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
const APP_URL = Deno.env.get("APP_URL") || "https://pivotyes.github.io/DousefireProposals/";
const REDIRECT = Deno.env.get("QBO_REDIRECT_URI") || `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbo-callback`;
const DISCOVERY = ENV === "production"
  ? "https://developer.api.intuit.com/.well-known/openid_configuration"
  : "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";

async function tokenEndpoint(): Promise<string> {
  try { const r = await fetch(DISCOVERY); if (r.ok) { const d = await r.json(); if (d.token_endpoint) return d.token_endpoint; } } catch { /* fall back */ }
  return "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
}
const back = (status: string) => new Response(null, { status: 302, headers: { Location: `${APP_URL}?qbo=${status}` } });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const code = u.searchParams.get("code"), state = u.searchParams.get("state"), realmId = u.searchParams.get("realmId");
    if (u.searchParams.get("error")) return back("cancelled");
    if (!code || !state || !realmId) return back("error");

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // CSRF check: the state must be one we created in the last 15 minutes
    // One step: remove the state and get it back, so the same code can never be used twice
    const { data: st } = await admin.from("qbo_oauth_state").delete().eq("state", state).select("*").maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) return back("expired");

    const basic = btoa(`${Deno.env.get("QBO_CLIENT_ID")}:${Deno.env.get("QBO_CLIENT_SECRET")}`);
    const r = await fetch(await tokenEndpoint(), {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
    });
    const t = await r.json();
    if (!r.ok) { console.error("Token exchange failed", r.status, r.headers.get("intuit_tid"), JSON.stringify(t)); return back("error"); }

    const now = Date.now();
    const { error } = await admin.from("qbo_connection").upsert({
      id: 1, env: ENV, realm_id: realmId, access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: new Date(now + (t.expires_in || 3600) * 1000).toISOString(),
      refresh_expires_at: t.x_refresh_token_expires_in ? new Date(now + t.x_refresh_token_expires_in * 1000).toISOString() : null,
      connected_by: st.created_by, updated_at: new Date().toISOString(),
    });
    if (error) { console.error("Saving connection failed", error.message); return back("error"); }
    return back("connected");
  } catch (e) {
    console.error("Callback error", String(e));
    return back("error");
  }
});
