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
  const s = await kv.getSecret(name);
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
