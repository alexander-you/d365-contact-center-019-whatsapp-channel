import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToWhatsApp, parseOptionBlock, stripOptionBlock, planRender, resolveSelection, fromSuggestedActions, fromCards,
  inboundToText, isSystemEvent, splitText, assignSentLabels, Pending,
} from "../src/lib/mapping";
import { renderTemplate } from "../src/lib/templates";

const D = { prompt: "בחר/י אפשרות:", listButtonText: "אפשרויות" };
const block = (n: number, extra = "") =>
  `במה אוכל לעזור?\n⟦wa|auto||Contoso IT⟧${extra}\n` + Array.from({ length: n }, (_, i) => `⟦opt|id${i + 1}|אפשרות ${i + 1}|⟧`).join("\n");

test("markdown → WhatsApp formatting", () => {
  assert.equal(markdownToWhatsApp("**bold** and *it* ~~x~~"), "*bold* and _it_ ~x~");
  assert.equal(markdownToWhatsApp("[site](https://a.b)"), "site: https://a.b");
  assert.equal(markdownToWhatsApp("# Title"), "*Title*");
});

test("option block parse + strip", () => {
  const s = parseOptionBlock(block(3))!;
  assert.equal(s.options.length, 3);
  assert.equal(s.footer, "Contoso IT");
  assert.equal(s.options[0].id, "id1");
  assert.equal(stripOptionBlock(block(3)), "במה אוכל לעזור?");
});

test("2-3 options → buttons; block never sent", () => {
  const { plan } = planRender({ text: block(3) }, D);
  assert.equal(plan.kind, "buttons");
  if (plan.kind === "buttons") {
    assert.deepEqual(plan.buttons, ["אפשרות 1", "אפשרות 2", "אפשרות 3"]);
    assert.ok(!plan.body.includes("⟦"));
    assert.equal(plan.footer, "Contoso IT");
  }
});

test("6 options → list, 12 options → numbered text (max 10 parsed → list)", () => {
  assert.equal(planRender({ text: block(6) }, D).plan.kind, "list");
  const forced = planRender({ text: block(4).replace("⟦wa|auto|", "⟦wa|text|") }, D).plan;
  assert.equal(forced.kind, "text");
  if (forced.kind === "text") assert.match(forced.text, /1\. אפשרות 1/);
});

test("long + duplicate labels truncated and unique", () => {
  const o: Array<{ id: string; label: string; sent?: string }> = [{ id: "a", label: "שחרור משתמש נעול בבקשה דחוף" }, { id: "b", label: "שחרור משתמש נעול בבקשה דחוף מאוד" }];
  assignSentLabels(o, 20);
  assert.ok(o[0].sent!.length <= 20 && o[1].sent!.length <= 20);
  assert.notEqual(o[0].sent, o[1].sent);
});

test("selection: tap, number, typed label, stale", () => {
  const { set, plan } = planRender({ text: block(3) }, D);
  const p: Pending = { promptId: "p1", kind: plan.kind, source: set!.source, options: set!.options };
  assert.equal(resolveSelection(p, { type: "button", body: "אפשרות 2" })?.option.id, "id2");
  assert.equal(resolveSelection(p, { type: "text", body: " 3 " })?.option.id, "id3");
  assert.equal(resolveSelection(p, { type: "text", body: "אפשרות 1" })?.method, "typed");
  assert.equal(resolveSelection(p, { type: "button", body: "כפתור ישן" }), undefined);
});

test("URL option alone → external button", () => {
  const { plan } = planRender({ text: "לאתר:\n⟦url|לאתר Contoso|https://www.contoso.com⟧" }, D);
  assert.equal(plan.kind, "buttons");
  if (plan.kind === "buttons") assert.equal(plan.externalUrl, "https://www.contoso.com");
});

test("suggestedActions and adaptive cards are used when present", () => {
  const sa = fromSuggestedActions({ suggestedActions: { actions: [{ type: "imBack", title: "כן", value: "כן" }, { type: "imBack", title: "לא", value: "לא" }] } });
  assert.equal(sa?.options.length, 2);
  const ac = fromCards({ attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { body: [
    { type: "TextBlock", text: "Pick" }, { type: "Input.ChoiceSet", id: "c", choices: [{ title: "A", value: "a" }, { title: "B", value: "b" }] },
    { type: "ActionSet", actions: [{ type: "Action.Submit", title: "Send" }] }] } }] });
  assert.equal(ac?.choiceSetId, "c");
  assert.equal(ac?.options.length, 2);
});

test("inbound mapping + system events", () => {
  assert.equal(inboundToText({ type: "location", body: "32.1,34.8", caption: "בית" }), "📍 בית https://maps.google.com/?q=32.1,34.8");
  assert.equal(inboundToText({ type: "text", body: "hi", isForwarded: true }), "(הועבר) hi");
  assert.ok(isSystemEvent({ type: "message", name: "AgentAccepted", text: "EventName: **_AgentAccepted_**" }));
  assert.ok(!isSystemEvent({ type: "message", text: "שלום" }));
});

test("split long text and render template", () => {
  assert.equal(splitText("a".repeat(5000)).length, 2);
  assert.equal(renderTemplate("שלום {{1}}, פנייה {{2}}", { "1": "דנה\n", "2": "CAS-1" }), "שלום דנה, פנייה CAS-1");
});

test("inline choices flattened by Copilot Studio → list / buttons", () => {
  const msg = "שלום, כאן העוזר הדיגיטלי של מוקד ה-IT. במה אפשר לעזור?\n\nאיפוס סיסמה / חיבור מרחוק / מדפסת / תקלת רשת / תיבה משותפת / נציג";
  const r = planRender({ text: msg }, D);
  assert.equal(r.plan.kind, "list");
  assert.equal(r.set!.options.length, 6);
  if (r.plan.kind === "list") {
    assert.equal(r.plan.message, "שלום, כאן העוזר הדיגיטלי של מוקד ה-IT. במה אפשר לעזור?");
    assert.equal(r.plan.items[1].title, "חיבור מרחוק");
  }
  const b = planRender({ text: "האם הבעיה נפתרה?\n\nכן / לא" }, D);
  assert.equal(b.plan.kind, "buttons");
  const sel = resolveSelection({ promptId: "p", kind: "list", source: "inline", options: r.set!.options }, { type: "list", body: "נציג" });
  assert.equal(sel?.option.label, "נציג");
});

test("inline choices: prose is not converted", () => {
  for (const text of [
    "שורה אחת בלי פסקה / עם לוכסן",
    "שלום\n\nאפשר לבחור באתר https://a.b / או בטלפון",
    "הסבר\n\nזה משפט ארוך מאוד שמכיל לוכסן / והוא לא אמור להפוך לכפתורים בכלל.",
    "שלום\n\nכן / כן",
  ]) assert.equal(planRender({ text }, D).plan.kind, "text", text);
});

import { checkForO19, mediaUrlOf, extOf, mimeOf } from "../src/lib/media";

test("019 file rules: type, size and extension", () => {
  assert.deepEqual(checkForO19("invoice.pdf", "application/pdf", 1024), { ok: true, name: "invoice.pdf" });
  const img = checkForO19("photo", "image/png", 1024);
  assert.equal(img.ok && img.name, "photo.png");
  const big = checkForO19("big.jpg", "image/jpeg", 6 * 1024 * 1024);
  assert.equal(big.ok, false);
  assert.equal(checkForO19("run.exe", "application/octet-stream", 10).ok, false);
  assert.equal(checkForO19("סיכום שיחה.docx", "", 10).ok, true);
});

test("019 media link detection and helpers", () => {
  assert.equal(mediaUrlOf({ type: "image", body: "https://x.example/a.jpg" }), "https://x.example/a.jpg");
  assert.equal(mediaUrlOf({ type: "image", media: { url: "https://x.example/b.png" }, body: "" }), "https://x.example/b.png");
  assert.equal(mediaUrlOf({ type: "image", media: "https://x.example/c.pdf" }), "https://x.example/c.pdf");
  assert.equal(mediaUrlOf({ type: "image", body: "not a link" }), undefined);
  assert.equal(extOf("a.B.JPEG"), "jpeg");
  assert.equal(mimeOf("x.pdf"), "application/pdf");
});
import { referralOf } from "../src/lib/processors";

test("referral: quoted message id and ad referral", () => {
  assert.deepEqual(referralOf({ quoteUnique: "Q1", referral: { source_id: "ad1", headline: "h" } }), { quoteUnique: "Q1", referral: { source_id: "ad1", headline: "h" } });
  assert.deepEqual(referralOf({ quote: false, referral: false }), {});
  assert.deepEqual(referralOf({ referral: "" }), {});
  assert.deepEqual(referralOf({ referral: '{"source_id":"x"}' }), { referral: { source_id: "x" } });
});