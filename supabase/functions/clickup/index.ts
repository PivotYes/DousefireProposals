// Supabase Edge Function: clickup
// Finds jobs in the ClickUp "Proposals" list, reads their fields, and saves proposal files to the job as attachments.
// Needs two secrets (Supabase > Edge Functions > Secrets): CLICKUP_TOKEN and CLICKUP_LIST_ID.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const API = "https://api.clickup.com/api/v2";
// Job statuses the search looks in. The app can send its own list; otherwise these are used.
const DEFAULT_STATUSES = ["open", "in progress"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Turn a ClickUp custom field into plain text
function fieldText(f: any): string {
  const v = f.value;
  if (v === undefined || v === null || v === "") return "";
  const opts = f.type_config?.options || [];
  switch (f.type) {
    case "drop_down": {
      const o = opts.find((x: any) => x.id === v || x.orderindex === v || String(x.orderindex) === String(v));
      return o ? (o.name ?? o.label ?? "") : String(v);
    }
    case "labels":
      return (Array.isArray(v) ? v : []).map((id: string) => {
        const o = opts.find((x: any) => x.id === id);
        return o ? (o.label ?? o.name) : "";
      }).filter(Boolean).join(", ");
    case "location":
      return v.formatted_address || "";
    case "date":
      return new Date(Number(v)).toLocaleDateString("en-US", { timeZone: "America/New_York" });
    case "users":
    case "people":
      return (Array.isArray(v) ? v : []).map((u: any) => u.username || u.email).filter(Boolean).join(", ");
    case "tasks":
    case "list_relationship":
      // Related tasks (e.g. the customer): just the names, no links
      return (Array.isArray(v) ? v : []).map((t: any) => t.name).filter(Boolean).join(", ");
    case "checkbox":
      return v === true || v === "true" ? "Yes" : "No";
    default:
      if (Array.isArray(v) && v.every((x: any) => x && typeof x === "object" && "name" in x)) return v.map((x: any) => x.name).join(", ");
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

function parseTaskId(input: string): string {
  const s = String(input || "").trim();
  const m = s.match(/\/t\/(?:\d+\/)?([A-Za-z0-9_-]+)/); // https://app.clickup.com/t/<team>/<id> or /t/<id>
  return m ? m[1] : s.replace(/^#/, "");
}

// Reads the Proposals list from ClickUp, 5 pages (500 tasks) at a time instead of one page after another,
// and keeps the result for a minute so repeat searches don't go back to ClickUp.
let CACHE: { at: number; key: string; jobs: any[] } = { at: 0, key: "", jobs: [] };
async function loadJobs(listId: string, H: Record<string, string>, wanted: string[]) {
  const key = listId + "|" + wanted.join("|");
  if (CACHE.key === key && Date.now() - CACHE.at < 60000) return CACHE.jobs;
  const page = async (n: number, sq: string) => {
    const r = await fetch(`${API}/list/${listId}/task?page=${n}&subtasks=true${sq}`, { headers: H });
    const d = await r.json();
    if (!r.ok) throw new Error(String(d?.err || r.status));
    return d;
  };
  const scan = async (byStatus: boolean) => {
    const sq = byStatus ? wanted.map((st) => `&statuses[]=${encodeURIComponent(st)}`).join("") : "";
    const out = new Map<string, any>();
    let seen = 0;
    for (let start = 0; start < 20; start += 5) {
      const batch = await Promise.all([0, 1, 2, 3, 4].map((i) => page(start + i, sq)));
      let done = false;
      for (const d of batch) {
        const tasks = d.tasks || [];
        seen += tasks.length;
        for (const t of tasks) {
          const status = String(t.status?.status || "").toLowerCase();
          if (wanted.includes(status)) out.set(t.id, { id: t.id, name: t.name, status: t.status?.status || "", url: t.url, custom_id: String(t.custom_id || "").toLowerCase() });
        }
        if (d.last_page || !tasks.length) done = true;
      }
      if (done) break;
    }
    return { jobs: [...out.values()], seen };
  };
  let res = { jobs: [] as any[], seen: 0 };
  try { res = await scan(true); } catch { /* fall through to a full read */ }
  // Nothing came back for those status names (they may be spelled differently in ClickUp): read the whole list and filter here
  if (!res.seen) res = await scan(false);
  CACHE = { at: Date.now(), key, jobs: res.jobs };
  return res.jobs;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = Deno.env.get("CLICKUP_TOKEN"), listId = Deno.env.get("CLICKUP_LIST_ID");
    if (!token || !listId) return json({ error: "missing_setup" }, 500);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: ok, error } = await sb.rpc("is_team");
    if (error || !ok) return json({ error: "not_on_team" }, 403);

    const body = await req.json();
    const H = { Authorization: token };

    // Open and In Progress jobs. "list" returns all of them (the app searches them as you type); "search" filters by name here.
    if (body.action === "list" || body.action === "search") {
      const wanted = (Array.isArray(body.statuses) && body.statuses.length ? body.statuses : DEFAULT_STATUSES)
        .map((s: unknown) => String(s).trim().toLowerCase());
      let jobs: any[];
      try { jobs = await loadJobs(listId, H, wanted); }
      catch (e) { return json({ error: "clickup_error", detail: String(e) }, 502); }
      if (body.action === "list") return json({ tasks: jobs });
      const q = String(body.q || "").trim().toLowerCase();
      if (!q) return json({ tasks: [] });
      return json({ tasks: jobs.filter((t) => t.name.toLowerCase().includes(q) || t.id === q || t.custom_id === q).slice(0, 20) });
    }

    // Only tasks in the Proposals list can be read or have files attached
    const getTask = async (id: string) => {
      const r = await fetch(`${API}/task/${encodeURIComponent(id)}`, { headers: H });
      const t = await r.json().catch(() => ({}));
      if (!r.ok) return { error: (r.status === 404 || r.status === 401) ? "not_found" : "clickup_error", detail: t?.err || r.status, status: r.status };
      if (String(t.list?.id || "") !== String(listId)) return { error: "not_found", detail: "not in the Proposals list", status: 404 };
      return { t };
    };

    if (body.action === "get") {
      const id = parseTaskId(body.task);
      const g: any = await getTask(id);
      if (g.error) return json({ error: g.error, detail: g.detail }, g.error === "not_found" ? 404 : 502);
      const t = g.t;
      const fields = (t.custom_fields || []).map((f: any) => ({ name: f.name, type: f.type, value: fieldText(f) }));
      return json({ id: t.id, name: t.name, url: t.url, status: t.status?.status || "", list: t.list?.name || "", fields });
    }

    if (body.action === "attach") {
      const id = parseTaskId(body.task);
      const g: any = await getTask(id);
      if (g.error) return json({ error: g.error, detail: g.detail }, g.error === "not_found" ? 404 : 502);
      const bytes = Uint8Array.from(atob(String(body.base64 || "")), (c) => c.charCodeAt(0));
      if (!bytes.length) return json({ error: "bad_request" }, 400);
      const form = new FormData();
      form.append("attachment", new Blob([bytes], { type: body.mime || "application/octet-stream" }), String(body.filename || "proposal.pdf"));
      const r = await fetch(`${API}/task/${encodeURIComponent(id)}/attachment`, { method: "POST", headers: H, body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: "clickup_error", detail: d?.err || r.status }, 502);
      return json({ ok: true, url: d.url || "" });
    }

    return json({ error: "bad_request" }, 400);
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
