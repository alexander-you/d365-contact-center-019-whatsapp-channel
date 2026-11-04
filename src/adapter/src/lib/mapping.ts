/**
 * Pure mapping logic (no I/O) – unit tested.
 * Spec §8 (message mapping) and §9 (option block, rendering, selection).
 */

// ---------------------------------------------------------------- formatting
export function markdownToWhatsApp(md: string): string {
  if (!md) return "";
  let s = md.replace(/\r\n/g, "\n");
  s = s.replace(/```([\s\S]*?)```/g, "```$1```");
  s = s.replace(/`([^`\n]+)`/g, "```$1```");
  s = s.replace(/\*\*(.+?)\*\*/g, "\u0001$1\u0001"); // protect bold
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1_$2_"); // *italic* -> _italic_
  s = s.replace(/\u0001(.+?)\u0001/g, "*$1*");
  s = s.replace(/~~(.+?)~~/g, "~$1~");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2");
  s = s.replace(/^#{1,6}\s*(.+)$/gm, "*$1*");
  return s.trim();
}

export function splitText(s: string, max = 4096): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------- options
export type Mode = "auto" | "buttons" | "list" | "text";
export interface Option { id: string; label: string; desc?: string; sent?: string }
export interface OptionSet {
  source: "block" | "suggestedActions" | "card";
  mode: Mode;
  header?: string;
  footer?: string;
  options: Option[];
  url?: { label: string; target: string };
  cardText?: string;
  choiceSetId?: string;
}

const BLOCK_LINE = /^\s*⟦(wa|opt|url)\|([^⟧]*)⟧\s*$/;

export function hasOptionBlock(text?: string): boolean {
  return !!text && /⟦(wa|opt|url)\|/.test(text);
}

export function stripOptionBlock(text?: string): string {
  if (!text) return "";
  return text.split("\n").filter((l) => !BLOCK_LINE.test(l)).join("\n").trim();
}

export function parseOptionBlock(text?: string): OptionSet | undefined {
  if (!hasOptionBlock(text)) return undefined;
  const set: OptionSet = { source: "block", mode: "auto", options: [] };
  for (const line of text!.split("\n")) {
    const m = line.match(BLOCK_LINE);
    if (!m) continue;
    const parts = m[2].split("|");
    if (m[1] === "wa") {
      const mode = (parts[0] || "auto").trim() as Mode;
      set.mode = ["auto", "buttons", "list", "text"].includes(mode) ? mode : "auto";
      if (parts[1]?.trim()) set.header = parts[1].trim();
      if (parts[2]?.trim()) set.footer = parts[2].trim();
    } else if (m[1] === "opt") {
      const [id, label, desc] = parts.map((p) => p?.trim());
      if (label && set.options.length < 10) set.options.push({ id: id || label, label, desc: desc || undefined });
    } else if (m[1] === "url") {
      const [label, target] = parts.map((p) => p?.trim());
      if (label && /^https?:\/\/|^tel:|^mailto:/i.test(target ?? "")) set.url = { label, target };
    }
  }
  return set.options.length || set.url ? set : undefined;
}

export function fromSuggestedActions(act: any): OptionSet | undefined {
  const actions: any[] = act?.suggestedActions?.actions ?? [];
  if (!actions.length) return undefined;
  const set: OptionSet = { source: "suggestedActions", mode: "auto", options: [] };
  for (const a of actions) {
    const type = String(a.type ?? "imBack").toLowerCase();
    const label = String(a.title ?? a.text ?? a.value ?? "").trim();
    if (!label) continue;
    if (type === "openurl" || type === "call") {
      if (!set.url) set.url = { label, target: type === "call" ? `tel:${String(a.value).replace(/^PhoneNumber:/i, "")}` : String(a.value) };
    } else if (set.options.length < 10) {
      const value = typeof a.value === "string" ? a.value : label;
      set.options.push({ id: value, label: type === "messageback" ? String(a.text ?? label) : value === label ? label : label });
    }
  }
  return set.options.length || set.url ? set : undefined;
}

export function fromCards(act: any): OptionSet | undefined {
  for (const att of act?.attachments ?? []) {
    const c = att?.content;
    if (!c || typeof c !== "object") continue;
    if (att.contentType === "application/vnd.microsoft.card.hero" || att.contentType === "application/vnd.microsoft.card.thumbnail") {
      const set: OptionSet = { source: "card", mode: "auto", options: [], cardText: [c.title, c.subtitle, c.text].filter(Boolean).join("\n") };
      const img = c.images?.[0]?.url;
      if (img) set.header = `img:${img}`;
      for (const b of c.buttons ?? []) {
        const t = String(b.type ?? "imBack").toLowerCase();
        if (t === "openurl") set.url ??= { label: b.title, target: b.value };
        else if (set.options.length < 10) set.options.push({ id: String(b.value ?? b.title), label: String(b.title ?? b.value) });
      }
      if (set.options.length || set.url) return set;
    }
    if (att.contentType === "application/vnd.microsoft.card.adaptive") {
      const set: OptionSet = { source: "card", mode: "auto", options: [] };
      const texts: string[] = [];
      const walk = (items: any[]) => {
        for (const it of items ?? []) {
          if (it.type === "TextBlock" && it.text) texts.push(it.text);
          if (it.type === "Input.ChoiceSet") {
            set.choiceSetId = it.id;
            set.mode = "list";
            for (const ch of it.choices ?? []) if (set.options.length < 10) set.options.push({ id: String(ch.value), label: String(ch.title) });
          }
          if (it.type === "ActionSet") walkActions(it.actions);
          if (it.items) walk(it.items);
          if (it.columns) for (const col of it.columns) walk(col.items);
        }
      };
      const walkActions = (actions: any[]) => {
        for (const a of actions ?? []) {
          if (a.type === "Action.OpenUrl") set.url ??= { label: a.title, target: a.url };
          else if (a.type === "Action.Submit" && !set.choiceSetId && set.options.length < 10)
            set.options.push({ id: String(a.id ?? a.data?.actionSubmitId ?? a.title), label: String(a.title) });
        }
      };
      walk(c.body);
      walkActions(c.actions);
      set.cardText = texts.join("\n");
      if (set.options.length || set.url) return set;
    }
  }
  return undefined;
}

export function extractOptions(act: any): OptionSet | undefined {
  return parseOptionBlock(act?.text) ?? fromSuggestedActions(act) ?? fromCards(act);
}

// ---------------------------------------------------------------- labels
export function fit(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "…";
}

/** Truncate to limit and make unique; writes `sent` on each option. */
export function assignSentLabels(options: Option[], limit: number): void {
  const used = new Set<string>();
  for (const o of options) {
    let s = fit(o.label, limit);
    let n = 2;
    while (used.has(s.toLowerCase())) {
      const suffix = ` ${n++}`;
      s = fit(o.label, limit - suffix.length).replace(/…$/, "") + suffix;
    }
    used.add(s.toLowerCase());
    o.sent = s;
  }
}

// ---------------------------------------------------------------- render plan
export type RenderPlan =
  | { kind: "text"; text: string }
  | { kind: "buttons"; body: string; buttons: string[]; footer?: string; headerImageUrl?: string; externalUrl?: string }
  | { kind: "list"; message: string; buttonText: string; items: Array<{ title: string; description?: string }>; header?: string; footer?: string };

export function planRender(act: any, defaults: { prompt: string; listButtonText: string }): { plan: RenderPlan; set?: OptionSet } {
  const set = extractOptions(act);
  const baseText = markdownToWhatsApp(stripOptionBlock(act?.text) || set?.cardText || "");
  if (!set) return { plan: { kind: "text", text: baseText } };

  const prompt = baseText || defaults.prompt;
  const { options, url, mode } = set;
  const headerImage = set.header?.startsWith("img:") ? set.header.slice(4) : undefined;
  const headerText = set.header && !headerImage ? set.header : undefined;

  if (!options.length && url) {
    return { set, plan: { kind: "buttons", body: prompt, buttons: [fit(url.label, 20)], footer: set.footer, externalUrl: url.target } };
  }
  const tail = url ? `\n🔗 ${url.label}: ${url.target}` : "";
  const wantButtons = mode === "buttons" || (mode === "auto" && options.length <= 3);
  const wantList = mode === "list" || (mode === "auto" && options.length <= 10);

  if (mode !== "text" && wantButtons && options.length <= 3) {
    assignSentLabels(options, 20);
    return { set, plan: { kind: "buttons", body: prompt + tail, buttons: options.map((o) => o.sent!), footer: set.footer, headerImageUrl: headerImage } };
  }
  if (mode !== "text" && wantList && options.length <= 10) {
    assignSentLabels(options, 24);
    return {
      set,
      plan: { kind: "list", message: prompt + tail, buttonText: defaults.listButtonText, header: headerText, footer: set.footer,
        items: options.map((o) => ({ title: o.sent!, description: o.desc })) },
    };
  }
  options.forEach((o, i) => (o.sent = String(i + 1)));
  return { set, plan: { kind: "text", text: `${prompt}\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}${tail}` } };
}

// ---------------------------------------------------------------- selection
export interface Pending { promptId: string; kind: RenderPlan["kind"]; source: OptionSet["source"]; choiceSetId?: string; options: Option[] }

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function resolveSelection(p: Pending | undefined, inbound: { type: string; body: string }):
  { option: Option; index: number; method: "tap" | "number" | "typed" } | undefined {
  if (!p?.options?.length) return undefined;
  const body = inbound.body ?? "";
  const isTap = inbound.type === "button" || inbound.type === "list";
  let i = p.options.findIndex((o) => o.sent === body);
  if (i < 0) i = p.options.findIndex((o) => norm(o.sent ?? "") === norm(body));
  if (i >= 0) return { option: p.options[i], index: i + 1, method: isTap ? "tap" : "typed" };
  if (/^\s*\d{1,2}\s*$/.test(body)) {
    const n = Number(body);
    if (n >= 1 && n <= p.options.length) return { option: p.options[n - 1], index: n, method: "number" };
  }
  i = p.options.findIndex((o) => norm(o.label) === norm(body));
  if (i >= 0) return { option: p.options[i], index: i + 1, method: isTap ? "tap" : "typed" };
  return undefined;
}

// ---------------------------------------------------------------- inbound 019 → text
export function inboundToText(push: any): string {
  const t = String(push.type ?? "text");
  const body = String(push.body ?? "");
  const caption = push.caption ? String(push.caption) : "";
  const fwd = push.isForwarded === true || push.isForwarded === "true" ? "(הועבר) " : "";
  switch (t) {
    case "text": case "button": case "list": return fwd + body;
    case "location": {
      const [lat, lng] = body.split(",").map((x) => x.trim());
      return `${fwd}📍 ${caption ? caption + " " : ""}https://maps.google.com/?q=${lat},${lng}`;
    }
    case "contacts": return `${fwd}👤 ${caption} ${body}`.trim();
    case "reaction": return "";
    case "order": return `${fwd}🛒 הזמנה`;
    default: return fwd + (caption || "");
  }
}

export const MEDIA_TYPES = new Set(["image", "audio", "video", "ptt", "document"]);

/** D365 webhook "event-as-message" (e.g. AgentAccepted) must never reach the customer. */
export function isSystemEvent(act: any): boolean {
  return !!act?.name || /^EventName:/i.test(String(act?.text ?? ""));
}

export const CLOSE_EVENTS = new Set([
  "ConversationClose", "ConversationClosed", "PrimaryAgentEndConversation", "AgentEndSession", "SupervisorForceClosedConversation", "AgentClosed",
]);
