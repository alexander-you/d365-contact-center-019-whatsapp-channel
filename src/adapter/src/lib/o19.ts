import { cfg, secret, SECRETS } from "./config";

/** 019 WhatsApp API client. Docs: https://docs.019sms.co.il/whatsapp/ */
export interface O19Result { success: boolean; ans?: { status: "OK" | "FAIL"; unique?: string; reason?: number | string; templateTimeLeft?: number }; message?: string; raw?: unknown }

export class O19Error extends Error {
  constructor(public reason: number, public api: string, public detail: string) { super(`019 ${api} failed reason=${reason} ${detail}`); }
  get windowClosed() { return this.reason === 7 || this.reason === 8; }
  get rateLimited() {
    return (this.api === "send-whatsapp-message" && this.reason === 9) || (this.api === "send-whatsapp-file" && this.reason === 11) ||
      ((this.api === "send-buttons" || this.api === "send-list") && this.reason === 15) || (this.api === "send-whatsapp-template" && this.reason === 21);
  }
}

// Simulator: records calls (memory + table) and returns success (used before the 019 token exists)
export const simulatorLog: Array<{ api: string; body: unknown; at: string }> = [];

async function post(api: string, body: Record<string, unknown>, method: "POST" | "GET" = "POST"): Promise<O19Result> {
  if (cfg.o19Simulator()) {
    const at = new Date().toISOString();
    simulatorLog.push({ api, body, at });
    if (simulatorLog.length > 200) simulatorLog.shift();
    const { upsert } = await import("./state");
    await upsert("Dedupe", "sim", `${(1e14 - Date.now()).toString().padStart(15, "0")}-${Math.random().toString(36).slice(2, 6)}`, { api, body: JSON.stringify(body).slice(0, 30000), at });
    return { success: true, ans: { status: "OK", unique: `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, reason: 1 } };
  }
  const token = await secret(SECRETS.o19Token);
  const res = await fetch(`${cfg.o19BaseUrl()}/${api}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8", Accept: "application/json; charset=utf-8" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { success: false, message: text }; }
  if (json && typeof json.data === "object" && json.data !== null && json.success === undefined) json = json.data; // 019 wraps some responses in { data: ... }
  const ok = res.ok && json.success !== false && (!json.ans || json.ans.status === "OK");
  console.log(JSON.stringify({ evt: "O19Call", api, http: res.status, ok, reason: json?.ans?.reason ?? json?.message }));
  if (!ok) {
    const reason = Number(json?.ans?.reason ?? (json?.message === "timingRuleError" ? 7 : res.status));
    throw new O19Error(reason, api, json?.message ?? text.slice(0, 200));
  }
  return { ...json, raw: json };
}

const fit = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "…");

export const o19 = {
  sendText: (source: string, destination: string, message: string, replyTo = "") =>
    post("send-whatsapp-message", { source, destination, message, replyTo }),

  sendButtons: (source: string, destination: string, p: { body: string; buttons: string[]; footer?: string; headerImageUrl?: string; externalUrl?: string }) => {
    const b: Record<string, unknown> = { source, destination, body: p.body, header: p.headerImageUrl ? "2" : "1" };
    if (p.headerImageUrl) b.headerURL = p.headerImageUrl;
    if (p.footer) b.footer = p.footer;
    p.buttons.slice(0, 3).forEach((t, i) => (b[`button${i + 1}`] = fit(t, 20)));
    if (p.externalUrl) b.buttonExternal = p.externalUrl;
    return post("send-buttons", b);
  },

  sendList: (source: string, destination: string, p: { message: string; buttonText: string; items: Array<{ title: string; description?: string }>; header?: string; footer?: string }) => {
    const b: Record<string, unknown> = { source, destination, message: p.message, buttonText: fit(p.buttonText, 19) };
    if (p.header) b.header = p.header;
    if (p.footer) b.footer = p.footer;
    p.items.slice(0, 10).forEach((it, i) => {
      b[`itemTitle${i + 1}`] = fit(it.title, 24);
      if (it.description) b[`itemDescription${i + 1}`] = fit(it.description, 72);
    });
    return post("send-list", b);
  },

  typing: (source: string, destination: string) => post("typing", { source, destination }),

  /** 019 send-whatsapp-file: public HTTPS link (extension must be supported), caption required. */
  sendFile: (source: string, destination: string, link: string, caption: string) =>
    post("send-whatsapp-file", { source, destination, link, message: caption || " ", replyTo: "" }),

  sendTemplate: (source: string, destination: string, p: { templateId: string; variables?: Record<string, string>; headerLink?: string; websiteVariable?: string; websiteVariable2?: string; otp?: string }) => {
    const b: Record<string, unknown> = { source, destination, templateId: p.templateId };
    if (p.variables && Object.keys(p.variables).length) {
      const d: Record<string, string> = { "1": "", "2": "", "3": "", "4": "", "5": "" };
      for (const [k, v] of Object.entries(p.variables)) d[k] = sanitizeVar(v);
      b.dynamicFieldsObject = d;
    }
    if (p.headerLink) b.headerLink = p.headerLink;
    if (p.websiteVariable) b.websiteVariable = p.websiteVariable;
    if (p.websiteVariable2) b.websiteVariable2 = p.websiteVariable2;
    if (p.otp) b.otp = p.otp;
    return post("send-whatsapp-template", b);
  },

  getTemplates: async (phone: string): Promise<any[]> => {
    if (cfg.o19Simulator()) return [];
    const token = await secret(SECRETS.o19Token);
    const res = await fetch(`${cfg.o19BaseUrl()}/get-phone-templates/${phone}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8", Accept: "application/json; charset=utf-8" } });
    let j: any = await res.json();
    if (j?.data && j.success === undefined) j = j.data;
    if (!j.success) throw new O19Error(Number(res.status), "get-phone-templates", JSON.stringify(j).slice(0, 200));
    return j.templates ?? [];
  },
};

/** 019 rules: no new lines and no 4+ consecutive spaces inside a variable. */
export function sanitizeVar(v: string): string {
  return String(v ?? "").replace(/[\r\n]+/g, " ").replace(/ {4,}/g, "   ").trim();
}

export const O19_REASON_TEXT: Record<number, string> = {
  1: "OK", 2: "Account/JSON error", 3: "General error", 4: "Invalid or unknown WhatsApp number", 5: "Empty body", 6: "WhatsApp error",
  7: "24h window closed", 8: "First contact – template required", 9: "Rate limit", 11: "Rate limit", 15: "Rate limit",
  12: "Template variables / structure error", 13: "Template language mismatch", 14: "Template header mismatch", 17: "Template variable count mismatch",
  19: "Template too long", 20: "Coupon error", 21: "High volume – retry", 24: "File error",
};

export const O19_FAILURE_TEXT: Record<number, string> = {
  1: "Server error – resend", 2: "Billing issue", 3: "Incorrect attached file", 4: "Account blocked", 5: "Daily limit reached",
  6: "Invalid to/from", 7: "Recipient WhatsApp outdated / ToS not accepted", 8: "24h window closed – use a template", 9: "Unknown error",
  10: "Template variables error", 11: "Context issue", 12: "Template not approved", 13: "Recipient marked trial", 14: "Marketing template limit (2/24h)",
  15: "Template not found", 16: "Rate limit exceeded", 17: "Permission issue",
};

/** Representative-facing Hebrew text: what happened + what to do. Send API reasons (O19Error.reason). */
export const O19_REASON_HE: Record<number, string> = {
  2: "שגיאת חשבון אצל ספק ה-WhatsApp – לפנות לתמיכה", 3: "שגיאה כללית אצל ספק ה-WhatsApp – לנסות שוב",
  4: "המספר אינו רשום ב-WhatsApp", 5: "ההודעה ריקה", 6: "שגיאת WhatsApp – לנסות שוב",
  7: "חלון 24 השעות נסגר – יש לשלוח תבנית (/tpl)", 8: "פנייה ראשונה ללקוח – יש לשלוח תבנית (/tpl)",
  9: "עומס שליחה – ההודעה תישלח שוב אוטומטית", 11: "עומס שליחה – ההודעה תישלח שוב אוטומטית", 15: "עומס שליחה – ההודעה תישלח שוב אוטומטית",
  12: "שגיאה במשתני התבנית", 13: "שפת התבנית אינה תואמת", 14: "כותרת התבנית אינה תואמת", 17: "מספר משתני התבנית אינו תואם",
  19: "התבנית ארוכה מדי", 20: "שגיאת קופון בתבנית", 21: "עומס – לנסות שוב בעוד רגע", 24: "שגיאה בקובץ – סוג או גודל לא נתמכים",
};

/** Representative-facing Hebrew text for delivery failures (system push messageUpdate). */
export const O19_FAILURE_HE: Record<number, string> = {
  1: "שגיאת שרת – לשלוח שוב", 2: "בעיית חיוב בחשבון ה-WhatsApp – לפנות לתמיכה", 3: "הקובץ המצורף פגום – לשלוח מחדש",
  4: "חשבון ה-WhatsApp חסום לשליחה – לפנות לתמיכה", 5: "הגעת למכסת השליחה היומית", 6: "כתובת שולח ונמען זהות",
  7: "אצל הלקוח גרסת WhatsApp ישנה או שלא אושרו תנאי השימוש", 8: "חלון 24 השעות נסגר – יש לשלוח תבנית (/tpl)",
  9: "שגיאה לא ידועה – לפנות לתמיכה", 10: "שגיאה במשתני התבנית", 11: "שגיאה בתוכן ההודעה", 12: "התבנית לא אושרה על ידי Meta",
  13: "מספר הלקוח מסומן כניסיון (trial)", 14: "נשלחו כבר 2 תבניות שיווק ללקוח ב-24 השעות האחרונות",
  15: "התבנית לא נמצאה", 16: "עומס שליחה – לנסות שוב בעוד רגע", 17: "אין הרשאת שליחה בחשבון ה-WhatsApp – לפנות לספק",
};
