import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

export const credential = new DefaultAzureCredential();

const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing app setting ${k}`);
  return v;
};
const opt = (k: string, d = ""): string => process.env[k] ?? d;

export const cfg = {
  tenantId: () => req("ENTRA_TENANT_ID"),
  clientId: () => req("ENTRA_CLIENT_ID"),
  allowedAudiences: () => req("ENTRA_ALLOWED_AUDIENCES").split(",").map((s) => s.trim()),
  d365BaseUrl: () => req("D365_MESSAGING_BASE_URL").replace(/\/$/, ""),
  d365OrgId: () => req("D365_ORGANIZATION_ID"),
  d365ChannelId: () => req("D365_CHANNEL_ID"),
  d365Scope: () => req("D365_TOKEN_SCOPE"),
  dataverseUrl: () => opt("DATAVERSE_URL").replace(/\/$/, ""),
  o19BaseUrl: () => opt("O19_BASE_URL", "https://019sms.co.il/whatsapp-api").replace(/\/$/, ""),
  o19Lines: () => req("O19_LINE_NUMBERS").split(",").map((s) => s.trim()).filter(Boolean),
  o19Simulator: () => opt("O19_SIMULATOR", "false").toLowerCase() === "true",
  // Off by default: D365 delivers custom events to the agent as empty messages, which breaks topics that handle every message.
  selectionEvent: () => opt("WA_SELECTION_EVENT", "false").toLowerCase() === "true",
  // Attachments (enabled per direction by the channel's "File attachments" setting in Contact Center admin)
  mediaContainer: () => opt("WA_MEDIA_CONTAINER", "wa-media"),
  mediaLinkMinutes: () => Number(opt("WA_MEDIA_LINK_MINUTES", "60")),
  mediaInboundMaxMb: () => Number(opt("WA_MEDIA_INBOUND_MAX_MB", "5")),
  mediaToBot: () => opt("WA_MEDIA_TO_BOT", "false").toLowerCase() === "true",
  /** phone-first (default): send files to the phone number when known, else the WhatsApp ID. id: always the WhatsApp ID. */
  fileDestination: () => (opt("WA_FILE_DESTINATION", "phone-first").toLowerCase() === "id" ? "id" : "phone-first") as "id" | "phone-first",
  noticeDedupeMinutes: () => Number(opt("WA_NOTICE_DEDUPE_MINUTES", "5")),
  mediaBotText: () => opt("WA_MEDIA_BOT_TEXT", "אפשר לשלוח קבצים בשיחה עם נציג. כתבו \"נציג\" כדי לעבור לנציג 🙂"),
  publicBaseUrl: () => opt("ADAPTER_PUBLIC_BASE_URL", process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : "").replace(/\/$/, ""),
  tableUrl: () => req("STORAGE_TABLE_URL"),
  keyVaultUrl: () => req("KEYVAULT_URL"),
  defaultPrompt: () => opt("DEFAULT_PROMPT", "בחר/י אפשרות:"),
  listButtonText: () => opt("LIST_BUTTON_TEXT", "אפשרויות"),
  mediaNotSupportedText: () => opt("MEDIA_NOT_SUPPORTED_TEXT", "כרגע ניתן לשלוח הודעות טקסט בלבד 🙏"),
  optOutKeywords: () => opt("OPTOUT_KEYWORDS", "STOP,הסר,הסרה").split(",").map((s) => s.trim().toLowerCase()),
  optInKeywords: () => opt("OPTIN_KEYWORDS", "START,הצטרף").split(",").map((s) => s.trim().toLowerCase()),
  outboundReplyWindowHours: () => Number(opt("OUTBOUND_REPLY_WINDOW_HOURS", "72")),
};

// --- Key Vault secrets (cached 5 minutes) -------------------------------------
let kv: SecretClient | undefined;
const cache = new Map<string, { v: string; exp: number }>();

export async function secret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && hit.exp > Date.now()) return hit.v;
  kv ??= new SecretClient(cfg.keyVaultUrl(), credential);
  // A fresh instance can briefly fail to resolve the private endpoint (EAI_AGAIN); retry before failing the request
  let s;
  for (let attempt = 1; ; attempt++) {
    try { s = await kv.getSecret(name); break; } catch (e) {
      const transient = /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/.test(String((e as Error).message));
      if (!transient || attempt >= 4) {
        if (hit) return hit.v; // stale value is better than failing a customer message
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!s.value) throw new Error(`Secret ${name} is empty`);
  cache.set(name, { v: s.value, exp: Date.now() + 5 * 60_000 });
  return s.value;
}

export const SECRETS = {
  o19Token: "wa019-o19-api-token",
  pathSecret: "wa019-webhook-path-secret",
  certPem: "wa019-adapter-cert-pem",
  certSha256: "wa019-adapter-cert-sha256",
};
