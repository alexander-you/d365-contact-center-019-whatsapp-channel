import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { cfg, secret, SECRETS } from "../lib/config";
import { AuthError, validateBearer, validateD365Webhook } from "../lib/auth";
import { firstSeen } from "../lib/state";
import { OutboundError, sendTemplate, syncTemplates } from "../lib/templates";
import { simulatorLog } from "../lib/o19";
import { enqueue } from "../lib/bus";


const json = (status: number, body: unknown): HttpResponseInit => ({ status, jsonBody: body });

async function checkPathSecret(req: HttpRequest): Promise<boolean> {
  const expected = await secret(SECRETS.pathSecret);
  const got = req.params.pathSecret ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 019 -> adapter (incoming messages)
app.http("In019Incoming", {
  route: "019/{pathSecret}/incoming", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (!(await checkPathSecret(req))) return { status: 404 };
    const p: any = await req.json().catch(() => undefined);
    if (!p || p.hook !== "new" || !p.unique || !p.from || !p.to) return json(400, { error: "invalid payload" });
    if (!cfg.o19Lines().includes(String(p.to))) { ctx.warn("unknown line"); return { status: 404 }; }
    if (!(await firstSeen("019in", String(p.unique)))) return json(200, { duplicate: true });
    const fromId = String(p.from_id ?? p.id ?? "");
    const waUser = fromId.includes(".") ? fromId : String(p.from);
    await enqueue("sb-inbound", p, { sessionId: `${p.to}:${waUser}`, messageId: String(p.unique) });
    return json(200, { ok: true });
  },
});

// ---------------------------------------------------------------- 019 -> adapter (DLR / system)
app.http("In019Status", {
  route: "019/{pathSecret}/status", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (!(await checkPathSecret(req))) return { status: 404 };
    const p: any = await req.json().catch(() => undefined);
    if (!p || !p.hook) return json(400, { error: "invalid payload" });
    const key = `${p.hook}:${p.type ?? ""}:${p.unique ?? ""}:${p.ack ?? p.messageUpdate ?? p.templateUpdate ?? ""}:${p.template ?? ""}`;
    if (!(await firstSeen("019st", key))) return json(200, { duplicate: true });
    await enqueue("sb-status", p);
    return json(200, { ok: true });
  },
});

// ---------------------------------------------------------------- D365 Messaging API webhook
app.http("InD365Activity", {
  route: "d365/v3/conversations/{conversationId}/activities", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    try { await validateD365Webhook(req.headers.get("authorization")); }
    catch (e) { ctx.warn(`webhook auth failed: ${(e as Error).message}`); return { status: 401 }; }
    const conversationId = req.params.conversationId;
    const act: any = await req.json().catch(() => undefined);
    if (!act) return json(400, { error: "invalid payload" });
    const id = act.id ?? `${act.type}:${act.name ?? ""}:${act.timestamp ?? ""}:${Buffer.from(String(act.text ?? "")).toString("base64").slice(0, 64)}`;
    if (!(await firstSeen("d365", `${conversationId}:${id}`))) return { status: 200 };
    await enqueue("sb-outbound", { conversationId, activity: act }, { sessionId: conversationId });
    return { status: 200 };
  },
});

// ---------------------------------------------------------------- Outbound API (custom connector / flows / custom page / MCS)
app.http("ApiOutboundTemplate", {
  route: "outbound/template", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    try { await validateBearer(req.headers.get("authorization")); }
    catch (e) { return json(401, { error: (e as Error).message }); }
    try {
      const body: any = await req.json();
      return json(200, await sendTemplate(body, ctx));
    } catch (e) {
      if (e instanceof OutboundError) return json(e.status, { error: e.code, message: e.message });
      if (e instanceof AuthError) return json(401, { error: e.message });
      ctx.error(e);
      return json(500, { error: "INTERNAL", message: (e as Error).message });
    }
  },
});

app.http("ApiTemplatesSync", {
  route: "outbound/templates/sync", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    try { await validateBearer(req.headers.get("authorization")); } catch (e) { return json(401, { error: (e as Error).message }); }
    return json(200, { synced: await syncTemplates(ctx) });
  },
});

// ---------------------------------------------------------------- ops: verify 019 credentials + list verified WhatsApp lines
app.http("OpsO19Phones", {
  route: "ops/o19/phones", methods: ["GET"], authLevel: "function",
  handler: async (req, ctx) => {
    try {
      const token = await secret(SECRETS.o19Token);
      const res = await fetch(`${cfg.o19BaseUrl()}/get-whatsapp-phones`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
      let body: any = await res.json().catch(() => ({}));
      if (body?.data && body.success === undefined) body = body.data;
      return json(200, { success: !!body?.success, phones: body?.phones ?? [] });
    } catch (e) {
      ctx.error(e);
      return json(500, { error: (e as Error).message });
    }
  },
});

// ---------------------------------------------------------------- health + simulator log
app.http("Health", {
  route: "health", methods: ["GET"], authLevel: "anonymous",
  handler: async () => json(200, { ok: true, simulator: cfg.o19Simulator(), time: new Date().toISOString() }),
});

app.http("SimulatorLog", {
  route: "simulator/log", methods: ["GET"], authLevel: "function",
  handler: async () => {
    if (!cfg.o19Simulator()) return { status: 404 };
    const { query, odata } = await import("../lib/state");
    const rows = await query<{ api: string; body: string; at: string }>("Dedupe", odata`PartitionKey eq ${"sim"}`, 50);
    return json(200, rows.map((r) => ({ at: r.at, api: r.api, body: JSON.parse(r.body) })));
  },
});

// ---------------------------------------------------------------- timer: template catalog sync
app.timer("TplSync", {
  schedule: "0 */15 * * * *",
  handler: async (_t, ctx) => {
    try { await syncTemplates(ctx); } catch (e) { ctx.warn(`template sync failed: ${(e as Error).message}`); }
  },
});
