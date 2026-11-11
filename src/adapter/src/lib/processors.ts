import { InvocationContext } from "@azure/functions";
import { cfg } from "./config";
import { d365, D365Error } from "./d365";
import { o19, O19Error, O19_FAILURE_HE, O19_FAILURE_TEXT, O19_REASON_HE } from "./o19";
import { Conversations, getEntity, upsert, remove, query, odata } from "./state";
import {
  CLOSE_EVENTS, MEDIA_TYPES, Pending, inboundToText, isSystemEvent, markdownToWhatsApp, planRender, resolveSelection, splitText,
} from "./mapping";
import { handleAgentTemplateCommand } from "./templates";
import { findRepliedMessage, findRecentMessage, markMessageReplied, onTemplateDelivery, ReplyMatch } from "./outbound";
import { attachmentSettings, checkForO19, download, extOf, mediaUrlOf, mimeOf, publishForO19 } from "./media";

export interface InboundPush {
  hook: "new"; unique: string; from: string; to: string; id?: string; from_id?: string; username?: string; senderName?: string;
  type: string; body?: string; caption?: string; isForwarded?: boolean | string; timestamp?: string; quote?: boolean; quoteUnique?: string;
}

const now = () => new Date().toISOString();

/** Message the customer replied to or tapped (019 quoteUnique), and click-to-WhatsApp ad referral, when present. */
export function referralOf(p: any): { quoteUnique?: string; referral?: unknown } {
  const out: { quoteUnique?: string; referral?: unknown } = {};
  if (p?.quoteUnique) out.quoteUnique = String(p.quoteUnique);
  let r = p?.referral;
  if (typeof r === "string") { const t = r.trim(); if (!t || t === "false") r = undefined; else { try { r = JSON.parse(t); } catch { out.referral = t; return out; } } }
  // 019 always sends {"ref_type":"none"} when there is no ad referral
  if (r && typeof r === "object" && Object.keys(r).length && String((r as any).ref_type ?? "").toLowerCase() !== "none") out.referral = r;
  return out;
}const AGENT_EVENTS = new Set(["AgentJoined", "AgentAccepted", "AgentAssigned", "AgentJoinedCustomerConversation", "TransferAgentAcceptSession"]);
const waIdOf = (p: InboundPush) => {
  const alt = String((p as any).from_id ?? p.id ?? "");
  return alt.includes(".") ? alt : String(p.from);
};

// ============================================================ notices to representative
/**
 * Posts an automated notice to the representative. With a dedupe key, the same notice is shown at most once per
 * conversation within WA_NOTICE_DEDUPE_MINUTES; repeats are counted and reported on the next notice.
 */
export async function notice(conversationId: string, text: string, ctx?: InvocationContext, dedupeKey?: string): Promise<void> {
  try {
    let suffix = "";
    if (dedupeKey) {
      const rk = dedupeKey.replace(/[\/\\#?]/g, "_").slice(0, 200);
      const row = await getEntity<{ lastUtc: string; suppressed?: number }>("Notices", conversationId, rk);
      const windowMs = cfg.noticeDedupeMinutes() * 60_000;
      if (row && Date.now() - Date.parse(row.lastUtc) < windowMs) {
        await upsert("Notices", conversationId, rk, { lastUtc: row.lastUtc, suppressed: (row.suppressed ?? 0) + 1 });
        return;
      }
      if (row?.suppressed) suffix = ` (חזר ${row.suppressed + 1} פעמים)`;
      await upsert("Notices", conversationId, rk, { lastUtc: now(), suppressed: 0 });
    }
    await d365.sendMessage(conversationId, { text: `[WhatsApp] ${text}${suffix}`, automated: true });
  } catch (e) {
    ctx?.warn(`notice failed: ${(e as Error).message}`);
  }
}

// ============================================================ inbound: customer -> D365
export async function processInbound(p: InboundPush, ctx: InvocationContext): Promise<void> {
  ctx.log(JSON.stringify({ evt: "O19Push", type: p.type, hasQuote: !!p.quoteUnique, hasReferral: !!referralOf(p).referral }));
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

  // 019 best practice for AI bots: show "typing…" (and blue ticks) while the agent prepares the answer.
  // Not when a representative handles the conversation – their real typing comes from D365.
  const typing = cfg.inboundTyping() && conv?.participant !== "agent"
    ? o19.typing(line, waUserId)
        .then(() => ctx.log(JSON.stringify({ evt: "TypingSent", source: "inbound" })))
        .catch((e) => ctx.log(`typing ignored: ${(e as Error).message}`))
    : Promise.resolve();

  // Attachments: honour the channel's "customers can send file attachments" setting; files go to representatives, not to the agent bot (unless WA_MEDIA_TO_BOT=true)
  let attachments: Array<{ contentType: string; contentUrl: string; name: string }> | undefined;
  if (MEDIA_TYPES.has(p.type)) {
    const url = mediaUrlOf(p);
    ctx.log(JSON.stringify({ evt: "O19Media", type: p.type, hasUrl: !!url, mediaKind: typeof (p as any).media, mediaKeys: (p as any).media && typeof (p as any).media === "object" ? Object.keys((p as any).media) : undefined }));
    const settings = await attachmentSettings();
    const withAgent = conversationId && conv?.participant === "agent";
    if (!settings.customers) {
      await safeSend(() => o19.sendText(line, waUserId, cfg.mediaNotSupportedText()), ctx);
      if (conversationId) await notice(conversationId, `📎 הלקוח שלח ${p.type} – קבלת קבצים כבויה בהגדרות הערוץ`, ctx);
      if (!p.caption) return;
    } else if (!withAgent && !cfg.mediaToBot()) {
      await safeSend(() => o19.sendText(line, waUserId, cfg.mediaBotText()), ctx);
      if (!p.caption) return;
    } else {
      try {
        if (!url) throw new Error("no media link in push");
        const f = await download(url, "o19", cfg.mediaInboundMaxMb() * 1024 * 1024);
        const ext = extOf(f.name ?? "") || extOf(new URL(url).pathname);
        const name = f.name ?? `${p.type}-${Date.now()}${ext ? "." + ext : ""}`;
        const contentType = f.contentType !== "application/octet-stream" ? f.contentType : mimeOf(name);
        attachments = [{ contentType, name, contentUrl: `data:${contentType};base64,${f.data.toString("base64")}` }];
        ctx.log(JSON.stringify({ evt: "MediaInbound", type: p.type, contentType, bytes: f.data.length }));
      } catch (e) {
        ctx.warn(`inbound media failed: ${(e as Error).message}`);
        const tooBig = /too large/.test((e as Error).message);
        await safeSend(() => o19.sendText(line, waUserId, tooBig ? `הקובץ גדול מדי (מקסימום ${cfg.mediaInboundMaxMb()}MB) 🙏` : "לא הצלחנו לקבל את הקובץ, אפשר לנסות לשלוח שוב 🙏"), ctx);
        if (conversationId) await notice(conversationId, `📎 הלקוח שלח ${p.type} אך הקובץ לא התקבל (${tooBig ? "גדול מדי" : "שגיאת הורדה"})`, ctx);
        if (!p.caption) return;
      }
    }
  }

  const messageText = inboundToText(p);
  const existed = !!conversationId;
  if (!conversationId) {
    conversationId = await createConversation(line, waUserId, phone, p, ctx);
  }
  // Template button tapped while a conversation is already open: mark the exact outbound message and tell the agent which button
  let templateReply: Record<string, unknown> | undefined;
  if (existed && p.type === "button" && p.quoteUnique) {
    const tm = await findRepliedMessage(String(p.quoteUnique), String(p.body ?? "")).catch(() => undefined);
    if (tm) {
      await markMessageReplied(tm, conversationId, ctx);
      templateReply = { messageId: tm.ref.id, template: tm.templateName, button: tm.button, buttonIndex: tm.buttonIndex, campaignId: tm.row.alex_campaignid, relatedEntity: tm.row.alex_relatedentity, relatedRecordId: tm.row.alex_relatedrecordid };
    }
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
        channelData: { wa: { selection: { id: sel.option.id, index: sel.index, method: sel.method }, o19Unique: p.unique, ...referralOf(p) } },
      });
      await remove("PendingOptions", conversationId, "latest");
      ctx.log(JSON.stringify({ evt: "OptionMatched", method: sel.method, source: pend.source, conversationId }));
    } else if (messageText || attachments) {
      await d365.sendMessage(conversationId, { from, text: messageText || undefined, attachments, channelData: { wa: { o19Unique: p.unique, type: p.type, ...referralOf(p), ...(templateReply ? { templateReply } : {}) } } });
    }
  } catch (e) {
    if (e instanceof D365Error && (e.status === 404 || e.status === 409 || e.status === 400)) {
      ctx.warn(`conversation ${conversationId} not active (${e.status}); recreating`);
      await Conversations.set(line, waUserId, { state: "Closed" });
      const newId = await createConversation(line, waUserId, phone, p, ctx);
      if (messageText || attachments) await d365.sendMessage(newId, { from, text: (sel?.option.label ?? messageText) || undefined, attachments });
      conversationId = newId;
    } else throw e;
  }
  await Conversations.set(line, waUserId, { conversationId, state: "Active", lastInboundUtc: now(), phone, profileName: p.senderName });
  await typing;
  ctx.log(JSON.stringify({ evt: "InboundReceived", type: p.type, conversationId }));
}

async function createConversation(line: string, waUserId: string, phone: string | undefined, p: InboundPush, ctx: InvocationContext): Promise<string> {
  const ref = referralOf(p);
  // Exact correlation: the outbound message the customer replied to (quoteUnique); fallback: latest template within the reply window
  const match = (await findRepliedMessage(ref.quoteUnique, p.type === "button" ? String(p.body ?? "") : undefined).catch(() => undefined))
    ?? (await findRecentMessage(line, [waUserId, phone ?? ""], cfg.outboundReplyWindowHours()).catch(() => undefined));
  const conversationcontext: Record<string, { isDisplayable: boolean; value: string | boolean }> = {
    wa_LineNumber: { isDisplayable: false, value: line },
    wa_UserId: { isDisplayable: false, value: waUserId },
    wa_ProfileName: { isDisplayable: true, value: p.senderName ?? "" },
    wa_EntryPoint: { isDisplayable: true, value: match ? (p.type === "button" ? "template-button" : "outbound-reply") : "organic" },
    wa_Is24hWindowOpen: { isDisplayable: false, value: true },
    // Mirror customercontext so the agent receives the values directly (msdyn_customengagementctx is only passed to the agent as a record reference)
    wa_CustomerId: { isDisplayable: false, value: `${line}:${waUserId}` },
  };
  if (phone) conversationcontext.wa_CustomerPhone = { isDisplayable: true, value: phone };
  const username = String((p as any).username ?? "").trim();
  if (username) conversationcontext.wa_Username = { isDisplayable: true, value: username };
  if (ref.quoteUnique) conversationcontext.wa_ReferralMessageId = { isDisplayable: false, value: ref.quoteUnique };
  if (ref.referral) conversationcontext.wa_Referral = { isDisplayable: false, value: JSON.stringify(ref.referral).slice(0, 2000) };
  if (match) Object.assign(conversationcontext, templateContext(match));
  const r = await d365.createConversation({
    customercontext: { customerid: `${line}:${waUserId}`, phonenumber: phone, preferredname: p.senderName },
    conversationcontext,
    conversationrequestid: p.unique,
    startmessage: match ? { message: `📤 WhatsApp template "${match.templateName ?? ""}" (${match.row.alex_senton ?? ""}): ${match.row.alex_renderedbody ?? ""}`.slice(0, 4000) } : undefined,
    skipdeflectionbot: false,
  });
  await Conversations.set(line, waUserId, { conversationId: r.conversationId, state: "Active", createdUtc: now(), phone, profileName: p.senderName, participant: "bot" });
  if (match) await markMessageReplied(match, r.conversationId, ctx);
  if (!phone) await notice(r.conversationId, "ℹ️ מספר הטלפון של הלקוח מוסתר (WhatsApp username)", ctx);
  ctx.log(JSON.stringify({ evt: "ConversationCreated", isNew: r.isNew, conversationId: r.conversationId, entry: conversationcontext.wa_EntryPoint.value, exact: !!match?.button || !!(match && ref.quoteUnique) }));
  return r.conversationId;
}

/** Context variables that tell the agent exactly which outbound message (and button) started the conversation. */
function templateContext(m: ReplyMatch): Record<string, { isDisplayable: boolean; value: string }> {
  const c: Record<string, { isDisplayable: boolean; value: string }> = {
    wa_TemplateName: { isDisplayable: true, value: m.templateName ?? "" },
    wa_OutboundMessageId: { isDisplayable: false, value: m.ref.id },
  };
  if (m.button) c.wa_TemplateButton = { isDisplayable: true, value: m.button };
  if (m.buttonIndex) c.wa_TemplateButtonIndex = { isDisplayable: false, value: String(m.buttonIndex) };
  if (m.row.alex_campaignid) c.wa_CampaignId = { isDisplayable: false, value: m.row.alex_campaignid };
  if (m.row.alex_relatedrecordid) c.wa_RelatedRecordId = { isDisplayable: false, value: m.row.alex_relatedrecordid };
  if (m.row.alex_relatedentity) c.wa_RelatedEntity = { isDisplayable: false, value: m.row.alex_relatedentity };
  return c;
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
    } else if (name && AGENT_EVENTS.has(name) && conv.participant !== "agent") {
      await Conversations.set(line, waUserId, { participant: "agent" });
    }
    return;
  }
  if (act.type !== "message") return;

  // Track who answers the customer: the agent bot sends with role "bot"; representatives don't
  const participant: "bot" | "agent" = act.from?.role === "bot" ? "bot" : "agent";
  if (conv.participant !== participant && act.channelData?.["messagingapi-oc"]?.type !== "AutomatedMessage") {
    await Conversations.set(line, waUserId, { participant });
  }

  // Representative slash command: /tpl <name> v1|v2
  if (typeof act.text === "string" && /^\s*\/tpl\b/i.test(act.text)) {
    await handleAgentTemplateCommand(conversationId, line, waUserId, act.text, ctx);
    return;
  }

  const files = (act.attachments ?? []).filter((a: any) => a?.contentUrl && !String(a.contentType ?? "").includes("card"));
  let captionUsed = false;
  if (files.length) {
    const settings = await attachmentSettings();
    if (participant === "agent" && !settings.agents) {
      await notice(conversationId, "📎 שליחת קבצים ללקוח כבויה בהגדרות הערוץ – הקובץ לא נשלח", ctx);
    } else {
      for (const [i, a] of files.entries()) {
        try {
          const f = await download(String(a.contentUrl), "d365");
          const contentType = a.contentType || f.contentType;
          const chk = checkForO19(String(a.name ?? f.name ?? "file"), contentType, f.data.length);
          if (!chk.ok) { await notice(conversationId, `📎 ${a.name ?? "הקובץ"} לא נשלח: ${chk.reason}`, ctx); continue; }
          const link = await publishForO19(f.data, chk.name, contentType);
          const caption = i === 0 && act.text ? markdownToWhatsApp(String(act.text)) : chk.name;
          if (i === 0 && act.text) captionUsed = true;
          // OOTB default (WA_FILE_DESTINATION=phone-first): 019 send-whatsapp-file rejects the WhatsApp ID (IL.…) with timingRuleError, so prefer the phone number
          const fileDest = cfg.fileDestination() === "phone-first" && conv.phone ? conv.phone : waUserId;
          const r = await o19.sendFile(line, fileDest, link, caption);
          await recordSent(conversationId, r.ans?.unique, "file");
          ctx.log(JSON.stringify({ evt: "MediaOutbound", conversationId, contentType, bytes: f.data.length, by: participant, dest: fileDest === waUserId ? "id" : "phone" }));
        } catch (e) {
          if (e instanceof O19Error && e.windowClosed) {
            const hidden = !conv.phone && waUserId.includes(".");
            await notice(conversationId, hidden
              ? "📎 הקובץ לא נשלח: ספק ה-WhatsApp אינו תומך כרגע בשליחת קבצים ללקוח שמספר הטלפון שלו מוסתר"
              : "⏱️ חלון 24 השעות נסגר – הקובץ לא נשלח", ctx);
            return;
          }
          ctx.warn(`outbound media failed: ${(e as Error).message}`);
          await notice(conversationId, `📎 ${a.name ?? "הקובץ"} לא נשלח ללקוח: ${e instanceof O19Error ? O19_REASON_HE[e.reason] ?? e.message : "שגיאת הורדה"}`, ctx, `file-${e instanceof O19Error ? e.reason : "download"}`);
        }
      }
    }
  }
  if (captionUsed && !act.suggestedActions?.actions?.length) return;

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
        await notice(conversationId, "⏱️ חלון 24 השעות נסגר – ההודעה לא נשלחה. שלח/י תבנית: /tpl <שם_תבנית> ערך1|ערך2", ctx, "window-closed");
        ctx.log(JSON.stringify({ evt: "WindowClosed", conversationId }));
        return;
      }
      if (e.rateLimited) throw e; // Service Bus retry with backoff
      await notice(conversationId, `⚠️ ההודעה לא נשלחה: ${O19_REASON_HE[e.reason] ?? `קוד ${e.reason}`}`, ctx, `send-${e.reason}`);
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
    if (ack === 3 && map?.partitionKey && map.partitionKey !== "tpl") await sendReadReceipt(map.partitionKey, map.sentUtc, ctx);
    return;
  }
  if (p.hook === "system") {
    ctx.log(JSON.stringify({ evt: "O19System", type: p.type, messageUpdate: p.messageUpdate, issues: p.issues }));
    if (p.type === "messages") {
      const reason = Number(p.messageUpdate);
      const text = O19_FAILURE_TEXT[reason] ?? `code ${reason}`;
      const map = (await query<{ partitionKey: string }>("MsgMap", odata`RowKey eq ${String(p.unique ?? "")}`, 1))[0];
      if (map?.partitionKey) await notice(map.partitionKey, `⚠️ ההודעה לא נמסרה ללקוח: ${O19_FAILURE_HE[reason] ?? `קוד ${reason}`}`, ctx, `dlr-${reason}`);
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
  await onTemplateDelivery(unique, ack, !!p.isBilledTemplate, failure, ctx);
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
