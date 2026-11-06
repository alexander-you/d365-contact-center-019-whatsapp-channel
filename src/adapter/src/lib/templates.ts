import { InvocationContext } from "@azure/functions";
import { cfg } from "./config";
import { d365 } from "./d365";
import { o19, O19Error, O19_REASON_TEXT, sanitizeVar } from "./o19";
import { dv, CH, mapTemplateStatus } from "./dataverse";
import { upsert, query, odata, getEntity, firstSeen } from "./state";

export interface TemplateRow {
  alex_watemplateid: string; alex_name: string; alex_templateid: string; alex_linenumber?: string; alex_body?: string;
  alex_variablecount?: number; alex_status?: number; alex_category?: number; alex_usage?: string; alex_variablebindings?: string;
}

export interface OutboundRequest {
  line?: string; to: string; templateId?: string; templateName?: string; variables?: Record<string, string>;
  headerLink?: string; websiteVariable?: string; websiteVariable2?: string; otp?: string;
  context?: { entryPoint?: string; campaignId?: string; relatedRecordId?: string; relatedEntity?: string; requestedBy?: string; skipBot?: boolean; conversationId?: string };
  idempotencyKey?: string;
}

export interface OutboundLogRow {
  partitionKey: string; rowKey: string; templateName?: string; templateId?: string; renderedBody?: string; campaignId?: string;
  relatedRecordId?: string; relatedEntity?: string; skipBot?: boolean; o19Unique?: string; sentUtc: string; dvId?: string; replied?: boolean;
}

export class OutboundError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }

export function renderTemplate(body: string, vars: Record<string, string> = {}): string {
  return (body ?? "").replace(/\{\{(\d)\}\}/g, (_, n) => sanitizeVar(vars[n] ?? ""));
}

const normPhone = (s: string) => String(s).replace(/[^\d.A-Za-z]/g, "").replace(/^0(5\d{8})$/, "972$1");

// ============================================================ catalog
export async function findTemplate(byIdOrName: string, line?: string): Promise<TemplateRow | undefined> {
  const esc = byIdOrName.replace(/'/g, "''");
  const sel = "$select=alex_watemplateid,alex_name,alex_templateid,alex_linenumber,alex_body,alex_variablecount,alex_status,alex_category,alex_usage,alex_variablebindings";
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

// ============================================================ send
export async function sendTemplate(req: OutboundRequest, ctx: InvocationContext): Promise<{ status: string; o19Unique?: string; renderedBody: string; outboundId?: string }> {
  const line = req.line ?? cfg.o19Lines()[0];
  const to = normPhone(req.to);
  if (!to) throw new OutboundError(400, "BAD_TO", "missing destination");
  if (req.idempotencyKey && !(await firstSeen("outbound", req.idempotencyKey))) throw new OutboundError(409, "DUPLICATE", "idempotencyKey already used");
  if (await getEntity("OptOut", line, to)) throw new OutboundError(409, "OPTED_OUT", "customer opted out");

  const tpl = await findTemplate(req.templateId ?? req.templateName ?? "", line);
  if (!tpl) throw new OutboundError(404, "TEMPLATE_NOT_FOUND", `template ${req.templateId ?? req.templateName} not found`);
  if (tpl.alex_status !== CH.status.approved) throw new OutboundError(409, "TEMPLATE_NOT_APPROVED", `template ${tpl.alex_name} is not approved`);

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.variables ?? {})) vars[k] = sanitizeVar(v);
  const need = tpl.alex_variablecount ?? 0;
  for (let i = 1; i <= need; i++) if (!vars[String(i)]) throw new OutboundError(400, "MISSING_VARIABLE", `variable {{${i}}} is required`);
  const renderedBody = renderTemplate(tpl.alex_body ?? "", vars);
  if (renderedBody.length > 1024) throw new OutboundError(400, "TOO_LONG", "template body + variables exceed 1024 chars");

  let unique: string | undefined;
  try {
    const r = await o19.sendTemplate(line, to, { templateId: tpl.alex_templateid, variables: vars, headerLink: req.headerLink, websiteVariable: req.websiteVariable, websiteVariable2: req.websiteVariable2, otp: req.otp });
    unique = r.ans?.unique;
  } catch (e) {
    if (e instanceof O19Error) throw new OutboundError(502, `O19_${e.reason}`, O19_REASON_TEXT[e.reason] ?? e.message);
    throw e;
  }

  const sentUtc = new Date().toISOString();
  const c = req.context ?? {};
  let outboundId: string | undefined;
  try {
    const rec: Record<string, unknown> = {
      subject: `WhatsApp: ${tpl.alex_name}`, alex_to: to, alex_linenumber: line, alex_templateid: tpl.alex_templateid,
      alex_variables: JSON.stringify(vars), alex_renderedbody: renderedBody, alex_deliverystatus: CH.delivery.sent,
      alex_o19unique: unique ?? "", alex_campaign: c.campaignId ?? "", alex_conversationid: c.conversationId ?? "",
    };
    if (c.relatedRecordId && c.relatedEntity) rec[`regardingobjectid_${c.relatedEntity}_alex_waoutboundmessage@odata.bind`] = `/${c.relatedEntity === "incident" ? "incidents" : c.relatedEntity + "s"}(${c.relatedRecordId})`;
    const created = await dv.post<{ activityid: string }>("alex_waoutboundmessages", rec);
    outboundId = created.activityid;
  } catch (e) { ctx.warn(`outbound activity not written: ${(e as Error).message}`); }

  await upsert("OutboundLog", line, `${to}:${(1e14 - Date.now()).toString().padStart(15, "0")}`, {
    templateName: tpl.alex_name, templateId: tpl.alex_templateid, renderedBody, campaignId: c.campaignId ?? "", relatedRecordId: c.relatedRecordId ?? "",
    relatedEntity: c.relatedEntity ?? "", skipBot: !!c.skipBot, o19Unique: unique ?? "", sentUtc, dvId: outboundId ?? "", replied: false,
  });
  if (unique) await upsert("MsgMap", c.conversationId ?? "outbound", unique, { sentUtc, kind: "template", dvId: outboundId ?? "" });

  if (c.conversationId) {
    await d365.sendMessage(c.conversationId, { text: `[WhatsApp] 📤 נשלחה תבנית "${tpl.alex_name}": ${renderedBody}`, automated: true }).catch(() => undefined);
  }
  ctx.log(JSON.stringify({ evt: "TemplateSent", templateId: tpl.alex_templateid, inConversation: !!c.conversationId }));
  return { status: "sent", o19Unique: unique, renderedBody, outboundId };
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
    await sendTemplate({ line, to: waUserId, templateName: m[1], variables, context: { entryPoint: "agent", conversationId } }, ctx);
  } catch (e) {
    await note(`❌ התבנית לא נשלחה: ${(e as Error).message}`);
  }
}

// ============================================================ reply correlation + DLR
export async function findRecentOutbound(line: string, waUserId: string, hours: number): Promise<(OutboundLogRow & { skipBot?: boolean }) | undefined> {
  const prefix = `${waUserId}:`;
  const rows = await query<OutboundLogRow>("OutboundLog", odata`PartitionKey eq ${line} and RowKey ge ${prefix} and RowKey lt ${waUserId + ";"}`, 1);
  const r = rows[0];
  if (!r || r.replied) return undefined;
  if (Date.now() - Date.parse(r.sentUtc) > hours * 3600_000) return undefined;
  return r;
}

export async function markOutboundReplied(r: OutboundLogRow, conversationId: string, ctx: InvocationContext) {
  await upsert("OutboundLog", r.partitionKey, r.rowKey, { replied: true });
  if (r.dvId) {
    await dv.patch(`alex_waoutboundmessages(${r.dvId})`, { alex_deliverystatus: CH.delivery.replied, alex_conversationid: conversationId })
      .catch((e) => ctx.warn(`outbound reply mark failed: ${(e as Error).message}`));
  }
}

export async function updateOutboundDelivery(unique: string, ack: number, billed: boolean, failure: string | undefined, ctx: InvocationContext) {
  const map = (await query<{ dvId?: string; kind?: string }>("MsgMap", odata`RowKey eq ${unique}`, 1))[0];
  if (!map?.dvId) return;
  const status = failure ? CH.delivery.failed : ack === 3 ? CH.delivery.read : ack === 2 ? CH.delivery.delivered : ack === 1 ? CH.delivery.sent : undefined;
  if (status === undefined) return;
  const patch: Record<string, unknown> = { alex_deliverystatus: status };
  if (failure) patch.alex_failurereason = failure;
  if (billed) patch.alex_billed = true;
  await dv.patch(`alex_waoutboundmessages(${map.dvId})`, patch).catch((e) => ctx.warn(`DLR update failed: ${(e as Error).message}`));
}
