// Supabase Edge Function: fill-proposal
// Reads a plain-language project description and returns answers for the Dousefire Proposal Builder.
// Needs one secret: ANTHROPIC_API_KEY (Supabase > Edge Functions > Secrets).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MODEL = "claude-sonnet-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TOOL = {
  name: "fill_proposal",
  description: "Fill in the proposal builder from the user's description.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "1 to 3 short plain sentences: what you filled in and what is still missing. No lists." },
      type: { type: "string", enum: ["res", "com"], description: "Job type. Only set when stated or clearly implied." },
      job: {
        type: "object",
        properties: {
          customer: { type: "string" }, project: { type: "string" },
          addr1: { type: "string", description: "Street address" }, addr2: { type: "string", description: "City, State Zip" },
          dwgDate: { type: "string" }, dwgBy: { type: "string" },
        },
      },
      answers: { type: "object", description: "Question id to answer. Choice: the option key. Multi: array of option keys. Number: number. Text: string." },
      areas: {
        type: "array", description: "Full list of sprinkler head areas. Only include when areas are mentioned or changed.",
        items: { type: "object", properties: {
          name: { type: "string" }, floors: { type: "string" }, heads: { type: "number" },
          type: { type: "string", enum: ["std", "conc", "up"] }, pipe: { type: "string", enum: ["cpvc", "steel"] },
        } },
      },
      risers: {
        type: "array", description: "Full list of standpipe risers (commercial only). Only include when risers are mentioned or changed.",
        items: { type: "object", properties: {
          loc: { type: "string" }, kind: { type: "string", enum: ["sp", "comb"] }, size: { type: "string", enum: ["4", "6", "8"] },
          hv: { type: "number" }, hvFloor: { type: "boolean" }, fcv: { type: "number" }, fcvSize: { type: "string", enum: ["1½", "2", "2½", "3", "4"] },
        } },
      },
    },
    required: ["reply"],
  },
};

const SYSTEM = (catalog: string) => `You fill in the DouseFire Sprinklers proposal builder from a project description.
Return answers only for what the user stated or clearly implied. Leave everything else out. Never invent prices, counts, sizes, names or dates.
Use option keys exactly as listed. For follow-up questions, only answer them when their parent question is answered the way the "asked when" note says.
Floors covered: use answers.floors (array of: basement, first, second, third, fourth, fifth, sixth), or answers.floorsCustom (text, e.g. "first-sixth floors") when the floors do not fit the list.
Sprinkler heads go in "areas": one entry per area with its own head count, head type and pipe. Residential jobs are always CPVC, so leave pipe out for them.
Standpipes: set answers.sp to "yes" and list each riser in "risers". "comb" means a combined standpipe-sprinkler riser; only combined risers have floor control assemblies (fcv). Hose valves are always 2 1/2".
When the user corrects something, return only what changed. If any area or riser changes, return the full list of areas or risers.
Write the reply in plain, friendly language for a sprinkler estimator. No em dashes.

Questions available, by job type (JSON):
${catalog}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "missing_key" }, 500);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: ok, error } = await sb.rpc("is_team");
    if (error || !ok) return json({ error: "not_on_team" }, 403);

    const body = await req.json();
    const catalog = JSON.stringify(body.catalog ?? {}).slice(0, 30000);
    const current = JSON.stringify(body.current ?? {}).slice(0, 20000);
    const history = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
      .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 6000) }));
    if (!history.length || history[history.length - 1].role !== "user") return json({ error: "bad_request" }, 400);
    while (history.length && history[0].role !== "user") history.shift();
    const last = history[history.length - 1];
    last.content = `Current builder state (JSON): ${current}\n\nUser: ${last.content}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system: SYSTEM(catalog),
        tools: [TOOL], tool_choice: { type: "tool", name: "fill_proposal" }, messages: history,
      }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: out?.error?.message || r.status }, 502);
    const use = (out.content || []).find((c: any) => c.type === "tool_use");
    return json(use ? use.input : { reply: "I could not read that. Try describing the project again." });
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
