import { InvocationContext } from "@azure/functions";
import { cfg } from "./config";
import { d365, D365Error } from "./d365";
import { o19, O19Error, O19_FAILURE_TEXT, O19_REASON_TEXT } from "./o19";
import { Conversations, getEntity, upsert, remove, query, odata } from "./state";
import {
  CLOSE_EVENTS, MEDIA_TYPES, Pending, inboundToText, isSystemEvent, planRender, resolveSelection, splitText,
} from "./mapping";
import { handleAgentTemplateCommand, findRecentOutbound, markOutboundReplied } from "./templates";

export interface InboundPush {
  hook: "new"; unique: string; from: string; to: string; id?: string; from_id?: string; username?: string; senderName?: string;
  type: string; body?: string; caption?: string; isForwarded?: boolean | string; timestamp?: string; quote?: boolean; quoteUnique?: string;
}

const now = () => new Date().toISOString();
const waIdOf = (p: InboundPush) => {
  const alt = String((p as any).from_id ?? p.id ?? "");
  return alt.includes(".") ? alt : String(p.from);
};

// ============================================================ notices to representative
export async function notice(conversationId: string, text: string, ctx?: InvocationContext): Promise<void> {
  try {
    await d365.sendMessage(conversationId, { text: `[WhatsApp] ${text}`, automated: true });
  } catch (e) {
    ctx?.warn(`notice failed: ${(e as Error).message}`);
  }
}

// ============================================================ inbound: customer -> D365
export async function processInbound(p: InboundPush, ctx: InvocationContext): Promise<void> {
  ctx.log(JSON.stringify({ evt: "O19Push", type: p.type }));
  const line = String(p.to);
  const waUserId = waIdOf(p);
  const phone = /^\d{8,15}$/.test(String(p.from)) ? String(p.from) : undefined;
  const text = (p.body ?? "").trim();
  const lower = text.toLowerCase();

  // Opt-out / opt-in keywords
  if (p.type === "text" && cfg.optOutKeywords().includes(lower)) {
    await upsert("OptOut", line, waUserId, { optedOutUtc: now() });
    await safeSend(() => o19.sendText(line, waUserId, "הוסרת מקבלת הודעות יזומות ב-WhatsApp. ניתן לשלוח START להצטרפות מחדש."), ctx);
    const conv = await Conversations.get(line, waUserId);
    if (conv?.state === "Active") await notice(conv.conversationId, "🚫 הלקוח ביקש הסרה מהודעות יזומות (opt-out)", ctx);
    ctx.log(JSON.stringify({ evt: "OptOut", line }));
    return;
  }
  if (p.type === "text" && cfg.optInKeywords().includes(lower)) {
    await remove("OptOut", line, waUserId);
    await safeSend(() => o19.sendText(line, waUserId, "נרשמת מחדש לקבלת הודעות ב-WhatsApp ✅"), ctx);
    return;
  }
  if (p.type === "reaction") return; // dropped by design

  let conv = await Conversations.get(line, waUserId);
  let conversationId = conv?.state === "Active" ? conv.conversationId : undefined;

  // Media is phase 2 – tell the customer and the representative
  if (MEDIA_TYPES.has(p.type)) {
    await safeSend(() => o19.sendText(line, waUserId, cfg.mediaNotSupportedText()), ctx);
    if (conversationId) await notice(conversationId, `📎 הלקוח שלח ${p.type} – קבצים אינם נתמכים כרגע בערוץ`, ctx);
    if (!p.caption) return;
  }

  const messageText = inboundToText(p);
  if (!conversationId) {
    conversationId = await createConversation(line, waUserId, phone, p, ctx);
  }

  const from = { id: waUserId, name: p.senderName ?? waUserId };
  const pending = await getEntity<{ json: string }>("PendingOptions", conversationId, "latest");
  const pend: Pending | undefined = pending ? JSON.parse(pending.json) : undefined;
  const sel = resolveSelection(pend, { type: p.type, body: text });

  try {
    if (sel && pend) {
      // §9.5: (1) custom event with full payload, (2) text (+ value, channelData)
      const payload = {
        promptId: pend.promptId, id: sel.option.id, label: sel.option.label, index: sel.index, method: sel.method,
        kind: pend.kind, source: pend.source, options: pend.options.map((o) => ({ id: o.id, label: o.label })),
        o19: p, receivedUtc: now(),
      };
      if (cfg.selectionEvent()) {
        await d365.customEvent(conversationId, "wa.selection", { wa_LastInteraction: { isDisplayable: false, value: JSON.stringify(payload) } });
      }
      const value = pend.choiceSetId ? { [pend.choiceSetId]: sel.option.id } : { id: sel.option.id, label: sel.option.label, promptId: pend.promptId, kind: pend.kind };
      await d365.sendMessage(conversationId, {
        from, text: sel.option.label, value,
        channelData: { wa: { selection: { id: sel.option.id, index: sel.index, method: sel.method }, o19Unique: p.unique } },
      });
      await remove("PendingOptions", conversationId, "latest");
      ctx.log(JSON.stringify({ evt: "OptionMatched", method: sel.method, source: pend.source, conversationId }));
    } else if (messageText) {
      await d365.sendMessage(conversationId, { from, text: messageText, channelData: { wa: { o19Unique: p.unique, type: p.type } } });
    }
  } catch (e) {
    if (e instanceof D365Error && (e.status === 404 || e.status === 409 || e.status === 400)) {
      ctx.warn(`conversation ${conversationId} not active (${e.status}); recreating`);
      await Conversations.set(line, waUserId, { state: "Closed" });
      const newId = await createConversation(line, waUserId, phone, p, ctx);
      if (messageText) await d365.sendMessage(newId, { from, text: sel?.option.label ?? messageText });
      conversationId = newId;
    } else throw e;
  }
  await Conversations.set(line, waUserId, { conversationId, state: "Active", lastInboundUtc: now(), phone, profileName: p.senderName });
  ctx.log(JSON.stringify({ evt: "InboundReceived", type: p.type, conversationId }));
}

async function createConversation(line: string, waUserId: string, phone: string | undefined, p: InboundPush, ctx: InvocationContext): Promise<string> {
  const out = await findRecentOutbound(line, waUserId, cfg.outboundReplyWindowHours());
  const conversationcontext: Record<string, { isDisplayable: boolean; value: string | boolean }> = {
    wa_LineNumber: { isDisplayable: false, value: line },
    wa_UserId: { isDisplayable: false, value: waUserId },
    wa_ProfileName: { isDisplayable: true, value: p.senderName ?? "" },
    wa_EntryPoint: { isDisplayable: true, value: out ? (p.type === "button" ? "template-button" : "outbound-reply") : "organic" },
    wa_Is24hWindowOpen: { isDisplayable: false, value: true },
    // Mirror customercontext so the agent receives the values directly (msdyn_customengagementctx is only passed to the agent as a record reference)
    wa_CustomerId: { isDisplayable: false, value: `${line}:${waUserId}` },
  };
  if (phone) conversationcontext.wa_CustomerPhone = { isDisplayable: true, value: phone };
  const username = String(p.username ?? "").trim();
  if (username) conversationcontext.wa_Username = { isDisplayable: true, value: username };
  if (out) {
    conversationcontext.wa_TemplateName = { isDisplayable: true, value: out.templateName ?? "" };
    conversationcontext.wa_CampaignId = { isDisplayable: false, value: out.campaignId ?? "" };
    conversationcontext.wa_RelatedRecordId = { isDisplayable: false, value: out.relatedRecordId ?? "" };
  }
  const r = await d365.createConversation({
    customercontext: { customerid: `${line}:${waUserId}`, phonenumber: phone, preferredname: p.senderName },
    conversationcontext,
    conversationrequestid: p.unique,
    startmessage: out ? { message: `📤 נשלחה תבנית WhatsApp (${out.templateName}) ב-${out.sentUtc}: ${out.renderedBody ?? ""}`.slice(0, 4000) } : undefined,
    skipdeflectionbot: out?.skipBot ?? false,
  });
  await Conversations.set(line, waUserId, { conversationId: r.conversationId, state: "Active", createdUtc: now(), phone, profileName: p.senderName });
  if (out) await markOutboundReplied(out, r.conversationId, ctx);
  if (!phone) await notice(r.conversationId, "ℹ️ מספר הטלפון של הלקוח מוסתר (WhatsApp username)", ctx);
  ctx.log(JSON.stringify({ evt: "ConversationCreated", isNew: r.isNew, conversationId: r.conversationId, entry: conversationcontext.wa_EntryPoint.value }));
  return r.conversationId;
}

async function safeSend(fn: () => Promise<unknown>, ctx: InvocationContext) {
  try { await fn(); } catch (e) { ctx.warn(`019 send failed: ${(e as Error).message}`); }
}

// ============================================================ outbound: D365 -> customer
export async function processOutbound(conversationId: string, act: any, ctx: InvocationContext): Promise<void> {
  ctx.log(JSON.stringify({
    evt: "D365Activity", conversationId, type: act?.type, name: act?.name, textLen: String(act?.text ?? "").length,
    hasBlock: /⟦(wa|opt|url)\|/.test(String(act?.text ?? "")), suggestedActions: act?.suggestedActions?.actions?.length ?? 0,
    attachments: (act?.attachments ?? []).map((a: any) => `${a?.contentType}${a?.content ? "+content" : ""}${a?.contentUrl ? "+url" : ""}`),
    keys: Object.keys(act ?? {}), fromRole: act?.from?.role,
  }));
  const conv = await Conversations.byConversation(conversationId);
  if (!conv) { ctx.warn(`unknown conversation ${conversationId}`); return; }
  const { line, waUserId } = conv;

  if (act.type === "typing") {
    try { await o19.typing(line, waUserId); } catch (e) { ctx.log(`typing ignored: ${(e as Error).message}`); }
    return;
  }
  if (isSystemEvent(act) || act.type === "event") {
    const name = act.name ?? String(act.text ?? "").match(/EventName:\s*\**_?([A-Za-z]+)/)?.[1];
    if (name && CLOSE_EVENTS.has(name)) {
      await Conversations.set(line, waUserId, { state: "Closed" });
      await remove("PendingOptions", conversationId, "latest");
      ctx.log(JSON.stringify({ evt: "ConversationClosed", name, conversationId }));
    }
    return;
  }
  if (act.type !== "message") return;

  // Representative slash command: /tpl <name> v1|v2
  if (typeof act.text === "string" && /^\s*\/tpl\b/i.test(act.text)) {
    await handleAgentTemplateCommand(conversationId, line, waUserId, act.text, ctx);
    return;
  }

  if (act.attachments?.some((a: any) => a?.contentUrl && !String(a.contentType ?? "").includes("card"))) {
    await notice(conversationId, "📎 שליחת קבצים ללקוח אינה נתמכת כרגע בערוץ (שלב 2)", ctx);
  }

  const { plan, set } = planRender(act, { prompt: cfg.defaultPrompt(), listButtonText: cfg.listButtonText() });
  try {
    if (plan.kind === "buttons") {
      const r = await o19.sendButtons(line, waUserId, plan);
      await recordSent(conversationId, r.ans?.unique, "buttons");
    } else if (plan.kind === "list") {
      const r = await o19.sendList(line, waUserId, plan);
      await recordSent(conversationId, r.ans?.unique, "list");
    } else {
      if (!plan.text) return;
      for (const part of splitText(plan.text)) {
        const r = await o19.sendText(line, waUserId, part);
        await recordSent(conversationId, r.ans?.unique, "text");
      }
    }
    if (set?.options.length) {
      const pending: Pending = { promptId: `${conversationId}:${Date.now()}`, kind: plan.kind, source: set.source, choiceSetId: set.choiceSetId, options: set.options };
      await upsert("PendingOptions", conversationId, "latest", { json: JSON.stringify(pending) });
      ctx.log(JSON.stringify({ evt: "OptionRendered", kind: plan.kind, count: set.options.length, source: set.source }));
    } else {
      await remove("PendingOptions", conversationId, "latest");
    }
  } catch (e) {
    if (e instanceof O19Error) {
      if (e.windowClosed) {
        await notice(conversationId, "⏱️ חלון 24 השעות נסגר – ההודעה לא נשלחה. שלח/י תבנית: /tpl <שם_תבנית> ערך1|ערך2", ctx);
        ctx.log(JSON.stringify({ evt: "WindowClosed", conversationId }));
        return;
      }
      if (e.rateLimited) throw e; // Service Bus retry with backoff
      await notice(conversationId, `⚠️ ההודעה לא נשלחה: ${O19_REASON_TEXT[e.reason] ?? e.message}`, ctx);
      if ([2, 3, 6].includes(e.reason)) throw e;
      return;
    }
    throw e;
  }
}

// ============================================================ status: DLR / system
export async function processStatus(p: any, ctx: InvocationContext): Promise<void> {
  if (p.hook === "update") {
    const ack = Number(p.ack);
    const unique = String(p.unique ?? "");
    const map = (await query<{ partitionKey: string; sentUtc: string; kind: string }>("MsgMap", odata`RowKey eq ${unique}`, 1))[0];
    await updateOutboundStatus(unique, ack, p, ctx);
    if (ack === 3 && map?.partitionKey) await sendReadReceipt(map.partitionKey, map.sentUtc, ctx);
    return;
  }
  if (p.hook === "system") {
    ctx.log(JSON.stringify({ evt: "O19System", type: p.type, messageUpdate: p.messageUpdate }));
    if (p.type === "messages") {
      const reason = Number(p.messageUpdate);
      const text = O19_FAILURE_TEXT[reason] ?? `code ${reason}`;
      const map = (await query<{ partitionKey: string }>("MsgMap", odata`RowKey eq ${String(p.unique ?? "")}`, 1))[0];
      if (map?.partitionKey) await notice(map.partitionKey, `⚠️ ההודעה לא נמסרה ללקוח: ${text}`, ctx);
      await updateOutboundStatus(String(p.unique ?? ""), 0, p, ctx, text);
      ctx.warn(JSON.stringify({ evt: "DeliveryFailed", reason }));
    } else if (p.type === "issues") {
      ctx.error(JSON.stringify({ evt: "O19AccountIssue", issues: p.issues })); // alert rule: Sev1
    } else if (p.type === "update") {
      ctx.warn(JSON.stringify({ evt: "O19DailyLimit", update: p.update }));
    } else if (p.type === "template") {
      const { onTemplateStatusPush } = await import("./templates");
      await onTemplateStatusPush(p, ctx);
    }
  }
}

async function updateOutboundStatus(unique: string, ack: number, p: any, ctx: InvocationContext, failure?: string) {
  if (!unique) return;
  const { updateOutboundDelivery } = await import("./templates");
  await updateOutboundDelivery(unique, ack, !!p.isBilledTemplate, failure, ctx);
}

/** §8.6 – one targeted lookup, then MessageRead for the latest rep/bot message (marks all previous as read). */
async function sendReadReceipt(conversationId: string, sentUtc: string, ctx: InvocationContext) {
  try {
    const debounce = await getEntity<{ at: string }>("Dedupe", "read", conversationId);
    if (debounce && Date.now() - Date.parse(debounce.at) < 10_000) return;
    await upsert("Dedupe", "read", conversationId, { at: now() });
    const start = new Date(Date.parse(sentUtc) - 120_000).toISOString();
    const { messages } = await d365.messages(conversationId, start, 20);
    const limit = Date.parse(sentUtc) + 5_000;
    const candidates = (messages ?? []).filter((m) => Date.parse(m.timestamp) <= limit && m.messageId);
    const last = candidates[candidates.length - 1];
    if (last) await d365.read(conversationId, last.messageId);
  } catch (e) {
    ctx.log(`read receipt skipped: ${(e as Error).message}`);
  }
}

/** Record outgoing 019 ids for DLR / read correlation. */
export async function recordSent(conversationId: string, unique: string | undefined, kind: string) {
  if (unique) await upsert("MsgMap", conversationId, unique, { sentUtc: now(), kind });
}
