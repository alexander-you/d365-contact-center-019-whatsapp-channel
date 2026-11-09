import { InvocationContext } from "@azure/functions";
import { cfg } from "./config";
import { d365 } from "./d365";
import { o19, O19Error, sanitizeVar } from "./o19";
import { dv, CH, mapTemplateStatus } from "./dataverse";


export interface TemplateRow {
  alex_watemplateid: string; alex_name: string; alex_templateid: string; alex_linenumber?: string; alex_body?: string;
  alex_variablecount?: number; alex_status?: number; alex_category?: number; alex_usage?: string; alex_variablebindings?: string; alex_quickreplies?: string;
}

export interface OutboundRequest {
  line?: string; to: string; templateId?: string; templateName?: string; variables?: Record<string, string>;
  scheduledOn?: string; createTimelineActivity?: boolean;
  context?: { entryPoint?: string; campaignId?: string; relatedRecordId?: string; relatedEntity?: string; conversationId?: string };
  idempotencyKey?: string;
}

export class OutboundError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }

export function renderTemplate(body: string, vars: Record<string, string> = {}): string {
  return (body ?? "").replace(/\{\{(\d)\}\}/g, (_, n) => sanitizeVar(vars[n] ?? ""));
}

const normPhone = (s: string) => String(s).replace(/[^\d.A-Za-z]/g, "").replace(/^0(5\d{8})$/, "972$1");

// ============================================================ catalog
export async function findTemplate(byIdOrName: string, line?: string): Promise<TemplateRow | undefined> {
  const esc = byIdOrName.replace(/'/g, "''");
  const sel = "$select=alex_watemplateid,alex_name,alex_templateid,alex_linenumber,alex_body,alex_variablecount,alex_status,alex_category,alex_usage,alex_variablebindings,alex_quickreplies";
  const r = await dv.get<{ value: TemplateRow[] }>(`alex_watemplates?${sel}&$filter=(alex_templateid eq '${esc}' or alex_name eq '${esc}')${line ? ` and alex_linenumber eq '${line}'` : ""}&$top=1`);
  return r.value[0];
}

export async function listAgentTemplates(line: string): Promise<TemplateRow[]> {
  const r = await dv.get<{ value: TemplateRow[] }>(
    `alex_watemplates?$select=alex_name,alex_variablecount,alex_usage&$filter=alex_linenumber eq '${line}' and alex_status eq ${CH.status.approved}&$top=50`);
  return r.value.filter((t) => !t.alex_usage || String(t.alex_usage).split(",").includes(String(CH.usage.agent)));
}

/** 019 returns numeric language codes that it doesn't document; "1" is Hebrew (observed). Unknown codes are kept as-is. */
const O19_LANGUAGES: Record<string, string> = { "1": "he" };
export const o19Language = (v: unknown) => { const s = String(v ?? "").trim(); return O19_LANGUAGES[s] ?? s; };

export async function syncTemplates(ctx: InvocationContext): Promise<number> {
  let n = 0;
  for (const line of cfg.o19Lines()) {
    const list = await o19.getTemplates(line);
    for (const t of list) {
      const body = String(t.body ?? "");
      const varCount = new Set(body.match(/\{\{\d\}\}/g) ?? []).size;
      const record: Record<string, unknown> = {
        alex_name: String(t.name ?? t.templateId).trim(), alex_linenumber: line, alex_language: o19Language(t.language),
        alex_body: body, alex_variablecount: varCount, alex_headertype: String(t.headers ?? ""), alex_buttons: String(t.buttons ?? ""),
        alex_quickreplies: [t.quickReply1, t.quickReply2, t.quickReply3].filter(Boolean).join(" | "),
        alex_ctawebsiteurl: String(t.callToActionWebsiteURL ?? ""), alex_status: mapTemplateStatus(Number(t.status)),
      };
      // Upsert by alternate key – admin-maintained columns (usage, labels, bindings) are not touched
      await dv.patch(`alex_watemplates(alex_templateid='${encodeURIComponent(String(t.templateId))}')`, record);
      n++;
    }
  }
  ctx.log(JSON.stringify({ evt: "TemplateSync", count: n }));
  return n;
}

export async function onTemplateStatusPush(p: any, ctx: InvocationContext) {
  const code = Number(p.templateUpdate);
  ctx.log(JSON.stringify({ evt: "TemplateStatusPush", template: p.template, code }));
  try {
    const rows = await dv.get<{ value: TemplateRow[] }>(`alex_watemplates?$select=alex_watemplateid&$filter=alex_name eq '${String(p.template).replace(/'/g, "''")}'`);
    for (const r of rows.value) {
      const patch: Record<string, unknown> = { alex_status: mapTemplateStatus(code) };
      const cat = Number(p.templateCategory);
      if (cat >= 1 && cat <= 3) patch.alex_category = [CH.category.utility, CH.category.marketing, CH.category.authentication][cat - 1];
      await dv.patch(`alex_watemplates(${r.alex_watemplateid})`, patch);
    }
  } catch (e) { ctx.warn(`template status update failed: ${(e as Error).message}`); }
}

// ============================================================ send (REST API) – creates a WhatsApp Message row; delivery is asynchronous
export async function sendTemplate(req: OutboundRequest, ctx: InvocationContext): Promise<{ messageId: string; status: string }> {
  const { queueMessage } = await import("./outbound");
  const template = req.templateId ?? req.templateName ?? "";
  if (!req.to || !template) throw new OutboundError(400, "BAD_REQUEST", "to and templateId/templateName are required");
  const c = req.context ?? {};
  try {
    const r = await queueMessage({
      to: req.to, template, variables: req.variables, line: req.line, scheduledOn: req.scheduledOn, campaignId: c.campaignId,
      idempotencyKey: req.idempotencyKey, relatedRecord: c.relatedEntity && c.relatedRecordId ? { entity: c.relatedEntity, id: c.relatedRecordId } : undefined,
      source: c.entryPoint === "agent" ? "Agent" : c.entryPoint === "campaign" ? "Campaign" : c.entryPoint === "flow" ? "Flow" : "API",
      createTimelineActivity: req.createTimelineActivity, conversationId: c.conversationId,
    });
    ctx.log(JSON.stringify({ evt: "MessageQueued", messageId: r.messageId, status: r.status }));
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    const m = msg.match(/-> (\d{3}): (.*)$/s);
    let detail = m?.[2] ?? msg;
    try { detail = JSON.parse(detail).error?.message ?? detail; } catch { /* keep text */ }
    throw new OutboundError(m && Number(m[1]) < 500 ? 400 : 502, "REJECTED", detail);
  }
}

// ============================================================ representative /tpl command
export async function handleAgentTemplateCommand(conversationId: string, line: string, waUserId: string, text: string, ctx: InvocationContext) {
  const m = text.trim().match(/^\/tpl\s+(\S+)\s*(.*)$/i);
  const note = (t: string) => d365.sendMessage(conversationId, { text: `[WhatsApp] ${t}`, automated: true }).catch(() => undefined);
  if (!m) {
    const list = await listAgentTemplates(line).catch(() => []);
    await note(`שימוש: /tpl <שם_תבנית> ערך1|ערך2\nתבניות זמינות: ${list.map((t) => `${t.alex_name} (${t.alex_variablecount ?? 0})`).join(", ") || "אין"}`);
    return;
  }
  const variables: Record<string, string> = {};
  (m[2] ? m[2].split("|") : []).forEach((v, i) => (variables[String(i + 1)] = v.trim()));
  try {
    await sendTemplate({ line, to: waUserId, templateName: m[1], variables, createTimelineActivity: true, context: { entryPoint: "agent", conversationId } }, ctx);
  } catch (e) {
    await note(`❌ התבנית לא נשלחה: ${(e as Error).message}`);
  }
}