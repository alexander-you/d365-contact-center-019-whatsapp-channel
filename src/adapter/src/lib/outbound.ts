import { InvocationContext } from "@azure/functions";
import { d365 } from "./d365";
import { dv, CH } from "./dataverse";
import { o19, O19Error, O19_REASON_TEXT } from "./o19";
import { getEntity, upsert, query, odata } from "./state";
import { findTemplate, renderTemplate } from "./templates";

/**
 * Outbound (proactive) WhatsApp messages.
 * Callers create a WhatsApp Message row (Custom API <prefix>_SendWhatsAppMessage). A Dataverse plug-in enqueues the row id
 * to Service Bus (sb-template); this module processes it, sends through 019 and keeps the row's lifecycle up to date.
 */
export const MSG = "alex_wamessage";
const MSG_SET = "alex_wamessages";
const MAX_ATTEMPTS = 5;

export interface MsgRow {
  alex_wamessageid: string; alex_name?: string; alex_to: string; alex_linenumber: string; alex_template?: string; alex_templateid?: string;
  alex_templatename?: string; alex_variables?: string; alex_messagestatus: number; alex_source?: number; alex_scheduledon?: string;
  alex_campaignid?: string; alex_relatedentity?: string; alex_relatedrecordid?: string; alex_conversationid?: string; alex_o19unique?: string;
  alex_attempts?: number; alex_createtimelineactivity?: boolean; alex_activityid?: string; alex_renderedbody?: string; alex_senton?: string; partitionid?: string;
}
export interface QueueRequest {
  to: string; template: string; variables?: Record<string, string>; line?: string; scheduledOn?: string; campaignId?: string;
  idempotencyKey?: string; relatedRecord?: { entity: string; id: string }; source?: "API" | "Flow" | "Agent" | "Bot" | "Campaign";
  createTimelineActivity?: boolean; conversationId?: string;
}

const COLS = "alex_wamessageid,alex_name,alex_to,alex_linenumber,alex_template,alex_templateid,alex_templatename,alex_variables,alex_messagestatus,alex_source,alex_scheduledon,alex_campaignid,alex_relatedentity,alex_relatedrecordid,alex_conversationid,alex_o19unique,alex_attempts,alex_createtimelineactivity,alex_activityid,alex_renderedbody,alex_senton";

let elastic: { value: boolean; until: number } | undefined;
/** The message table is Elastic where the environment supports it, otherwise Standard (same columns). Cached for 5 minutes. */
export async function isElastic(): Promise<boolean> {
  if (!elastic || elastic.until < Date.now()) {
    const m = await dv.get<{ TableType?: string }>(`EntityDefinitions(LogicalName='${MSG}')?$select=TableType`).catch(() => ({ TableType: "Standard" }));
    elastic = { value: m.TableType === "Elastic", until: Date.now() + 5 * 60_000 };
  }
  return elastic.value;
}
/** Elastic rows with a partition are addressed by the (id, partitionid) alternate key; standard rows by id. */
export const rowPath = (id: string, partitionId?: string) =>
  partitionId ? `${MSG_SET}(alex_wamessageid=${id},partitionid='${partitionId.replace(/'/g, "''")}')` : `${MSG_SET}(${id})`;

export async function readRow(id: string, partitionId?: string): Promise<MsgRow | undefined> {
  try { return await dv.get<MsgRow>(`${rowPath(id, partitionId)}?$select=${COLS}`); }
  catch (e) { if (/-> 404/.test((e as Error).message)) return undefined; throw e; }
}
// If-Match: * makes the PATCH an update only. Without it, a PATCH on an elastic row is an upsert and requires Assign privilege.
const patchRow = (row: { id: string; partitionId?: string }, data: Record<string, unknown>) => dv.patch(rowPath(row.id, row.partitionId), data, { "If-Match": "*" });

/** Creates a WhatsApp Message row through the Custom API (same validation for every caller). */
export async function queueMessage(req: QueueRequest): Promise<{ messageId: string; status: string }> {
  const body: Record<string, unknown> = { To: req.to, Template: req.template };
  if (req.variables && Object.keys(req.variables).length) body.Variables = JSON.stringify(req.variables);
  if (req.line) body.Line = req.line;
  if (req.scheduledOn) body.ScheduledOn = req.scheduledOn;
  if (req.campaignId) body.CampaignId = req.campaignId;
  if (req.idempotencyKey) body.IdempotencyKey = req.idempotencyKey;
  if (req.source) body.Source = req.source;
  if (req.createTimelineActivity) body.CreateTimelineActivity = true;
  if (req.conversationId) body.ConversationId = req.conversationId;
  if (req.relatedRecord) body.RelatedRecord = { "@odata.type": `Microsoft.Dynamics.CRM.${req.relatedRecord.entity}`, [`${req.relatedRecord.entity}id`]: req.relatedRecord.id };
  const r = await dv.post<{ MessageId: string; Status: string }>("alex_SendWhatsAppMessage", body);
  return { messageId: r.MessageId, status: r.Status };
}

// ============================================================ Service Bus processor (sb-template)
export async function processQueuedMessage(m: { id: string; partitionId?: string }, deliveryCount: number, ctx: InvocationContext): Promise<void> {
  const ref = { id: m.id, partitionId: m.partitionId || undefined };
  const row = await readRow(ref.id, ref.partitionId);
  if (!row) { ctx.warn(`message ${m.id} not found`); return; }
  const s = row.alex_messagestatus;
  if (![CH.msgStatus.queued, CH.msgStatus.scheduled, CH.msgStatus.sending].includes(s)) {
    ctx.log(JSON.stringify({ evt: "MessageSkipped", id: m.id, status: s }));
    return; // canceled, already sent, etc. – idempotent
  }
  if (row.alex_scheduledon && Date.parse(row.alex_scheduledon) > Date.now() + 60_000) {
    ctx.log(JSON.stringify({ evt: "MessageNotDue", id: m.id })); // re-scheduling an earlier time re-enqueues via the plug-in
    return;
  }
  const attempts = (row.alex_attempts ?? 0) + 1;
  await patchRow(ref, { alex_messagestatus: CH.msgStatus.sending, alex_attempts: attempts });

  const fail = async (code: string, reason: string) => {
    await patchRow(ref, { alex_messagestatus: CH.msgStatus.failed, alex_failurecode: code, alex_failurereason: reason.slice(0, 500) });
    ctx.warn(JSON.stringify({ evt: "MessageFailed", id: m.id, code }));
    if (row.alex_conversationid) await d365.sendMessage(row.alex_conversationid, { text: `[WhatsApp] ❌ The template wasn't sent: ${reason}`, automated: true }).catch(() => undefined);
  };

  if (await getEntity("OptOut", row.alex_linenumber, row.alex_to)) return fail("OPTED_OUT", "The customer opted out of proactive messages");
  const tpl = await findTemplate(row.alex_templateid || row.alex_template || "", row.alex_linenumber);
  if (!tpl) return fail("TEMPLATE_NOT_FOUND", `Template ${row.alex_templateid || row.alex_template} not found`);
  if (tpl.alex_status !== CH.status.approved) return fail("TEMPLATE_NOT_APPROVED", `Template ${tpl.alex_name} is not approved`);

  let vars: Record<string, string> = {};
  try { vars = row.alex_variables ? JSON.parse(row.alex_variables) : {}; } catch { return fail("BAD_VARIABLES", "Variables are not valid JSON"); }
  const renderedBody = renderTemplate(tpl.alex_body ?? "", vars);

  let unique: string | undefined;
  try {
    const r = await o19.sendTemplate(row.alex_linenumber, row.alex_to, { templateId: tpl.alex_templateid, variables: vars });
    unique = r.ans?.unique;
  } catch (e) {
    if (e instanceof O19Error && e.rateLimited && attempts < MAX_ATTEMPTS) throw e; // Service Bus retry with backoff
    if (e instanceof O19Error) return fail(`O19_${e.reason}`, O19_REASON_TEXT[e.reason] ?? e.message);
    if (deliveryCount >= MAX_ATTEMPTS) return fail("SEND_ERROR", (e as Error).message);
    throw e; // transient – retry
  }

  const sentOn = new Date().toISOString();
  const patch: Record<string, unknown> = { alex_messagestatus: CH.msgStatus.sent, alex_o19unique: unique ?? "", alex_renderedbody: renderedBody.slice(0, 4000), alex_senton: sentOn };
  const activityId = (row.alex_createtimelineactivity || row.alex_source === CH.msgSource.agent) ? await createTimelineActivity(row, tpl.alex_name, renderedBody, vars, unique, ctx) : undefined;
  if (activityId) patch.alex_activityid = activityId;
  await patchRow(ref, patch);
  if (unique) await upsert("MsgMap", "tpl", unique, { sentUtc: sentOn, kind: "template", msgId: m.id, partitionId: ref.partitionId ?? "", conversationId: row.alex_conversationid ?? "", activityId: activityId ?? "" });
  if (row.alex_conversationid) await d365.sendMessage(row.alex_conversationid, { text: `[WhatsApp] 📤 Template "${tpl.alex_name}" sent: ${renderedBody}`, automated: true }).catch(() => undefined);
  ctx.log(JSON.stringify({ evt: "MessageSent", id: m.id, template: tpl.alex_templateid, timeline: !!activityId }));
}

/** Hybrid timeline: an activity is created only for representative sends or when requested. */
async function createTimelineActivity(row: MsgRow, templateName: string, body: string, vars: Record<string, string>, unique: string | undefined, ctx: InvocationContext): Promise<string | undefined> {
  try {
    const rec: Record<string, unknown> = {
      subject: `WhatsApp: ${templateName}`, alex_to: row.alex_to, alex_linenumber: row.alex_linenumber, alex_templateid: row.alex_templateid,
      alex_variables: JSON.stringify(vars), alex_renderedbody: body, alex_deliverystatus: CH.delivery.sent, alex_o19unique: unique ?? "",
      alex_campaign: row.alex_campaignid ?? "", alex_conversationid: row.alex_conversationid ?? "",
    };
    const e = row.alex_relatedentity, id = row.alex_relatedrecordid;
    if (e && id) rec[`regardingobjectid_${e}_alex_waoutboundmessage@odata.bind`] = `/${e === "incident" ? "incidents" : e + "s"}(${id})`;
    return (await dv.post<{ activityid: string }>("alex_waoutboundmessages", rec)).activityid;
  } catch (e) { ctx.warn(`timeline activity not created: ${(e as Error).message}`); return undefined; }
}

// ============================================================ delivery receipts (019 DLR)
const ORDER = [CH.msgStatus.sent, CH.msgStatus.delivered, CH.msgStatus.read, CH.msgStatus.replied];

export async function onTemplateDelivery(unique: string, ack: number, billed: boolean, failure: string | undefined, ctx: InvocationContext): Promise<boolean> {
  const map = await getEntity<{ msgId: string; partitionId?: string; activityId?: string }>("MsgMap", "tpl", unique);
  if (!map?.msgId) return false;
  const next = failure ? CH.msgStatus.failed : ack === 3 ? CH.msgStatus.read : ack === 2 ? CH.msgStatus.delivered : undefined;
  if (next === undefined) return true;
  const row = await readRow(map.msgId, map.partitionId || undefined);
  if (!row) return true;
  if (!failure && ORDER.indexOf(next) <= ORDER.indexOf(row.alex_messagestatus)) return true; // never move backwards
  const patch: Record<string, unknown> = { alex_messagestatus: next };
  if (failure) { patch.alex_failurereason = failure; patch.alex_failurecode = "DELIVERY"; }
  await patchRow({ id: map.msgId, partitionId: map.partitionId || undefined }, patch).catch((e) => ctx.warn(`DLR update failed: ${(e as Error).message}`));
  if (map.activityId) {
    const a: Record<string, unknown> = { alex_deliverystatus: failure ? CH.delivery.failed : next === CH.msgStatus.read ? CH.delivery.read : CH.delivery.delivered };
    if (billed) a.alex_billed = true;
    if (failure) a.alex_failurereason = failure;
    await dv.patch(`alex_waoutboundmessages(${map.activityId})`, a).catch(() => undefined);
  }
  return true;
}

// ============================================================ replies (exact correlation by quoted message)
export interface ReplyMatch { row: MsgRow; ref: { id: string; partitionId?: string }; button?: string; buttonIndex?: number; templateName?: string; quickReplies?: string[] }

/** Finds the exact outbound message the customer replied to (019 quoteUnique), and the tapped template button. */
export async function findRepliedMessage(quoteUnique: string | undefined, buttonText?: string): Promise<ReplyMatch | undefined> {
  if (!quoteUnique) return undefined;
  const map = await getEntity<{ msgId: string; partitionId?: string }>("MsgMap", "tpl", quoteUnique);
  if (!map?.msgId) return undefined;
  const row = await readRow(map.msgId, map.partitionId || undefined);
  if (!row) return undefined;
  const tpl = row.alex_templateid ? await findTemplate(row.alex_templateid, row.alex_linenumber).catch(() => undefined) : undefined;
  const quickReplies = String(tpl?.alex_quickreplies ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const idx = buttonText ? quickReplies.findIndex((q) => q === buttonText.trim()) : -1;
  return { row, ref: { id: map.msgId, partitionId: map.partitionId || undefined }, button: buttonText, buttonIndex: idx >= 0 ? idx + 1 : undefined, templateName: row.alex_templatename ?? tpl?.alex_name, quickReplies };
}

export async function markMessageReplied(match: ReplyMatch, conversationId: string, ctx: InvocationContext) {
  const patch: Record<string, unknown> = { alex_messagestatus: CH.msgStatus.replied, alex_repliedon: new Date().toISOString(), alex_conversationid: conversationId };
  if (match.button) patch.alex_replybutton = match.button.slice(0, 200);
  if (match.buttonIndex) patch.alex_replybuttonindex = match.buttonIndex;
  await patchRow(match.ref, patch).catch((e) => ctx.warn(`reply mark failed: ${(e as Error).message}`));
  if (match.row.alex_activityid) await dv.patch(`alex_waoutboundmessages(${match.row.alex_activityid})`, { alex_deliverystatus: CH.delivery.replied, alex_conversationid: conversationId }).catch(() => undefined);
}

/** Fallback when the reply doesn't quote a message: latest template sent to this customer within the reply window. */
export async function findRecentMessage(line: string, recipients: string[], hours: number): Promise<ReplyMatch | undefined> {
  for (const to of recipients.filter(Boolean)) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const cols = (await isElastic()) ? `${COLS},partitionid` : COLS;
    const r = await dv.get<{ value: MsgRow[] }>(`${MSG_SET}?$select=${cols}&$filter=alex_to eq '${to.replace(/'/g, "''")}' and alex_linenumber eq '${line}' and alex_senton ge ${since} and (alex_messagestatus eq ${CH.msgStatus.sent} or alex_messagestatus eq ${CH.msgStatus.delivered} or alex_messagestatus eq ${CH.msgStatus.read})&$orderby=alex_senton desc&$top=1`)
      .catch(() => ({ value: [] as MsgRow[] }));
    const row = r.value[0];
    if (row) return { row, ref: { id: row.alex_wamessageid, partitionId: row.partitionid || undefined }, templateName: row.alex_templatename };
  }
  return undefined;
}

export { query, odata };
