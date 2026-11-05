import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { cfg, credential, secret, SECRETS } from "./config";
import { dv } from "./dataverse";
import { getToken } from "./auth";

// ---------------------------------------------------------------- channel settings (Contact Center admin decision)
export interface AttachmentSettings { customers: boolean; agents: boolean }
let settingsCache: { at: number; v: AttachmentSettings } | undefined;

/** Reads "File attachments" from the custom messaging channel. Fails closed (no attachments) when unreadable. */
export async function attachmentSettings(): Promise<AttachmentSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 5 * 60_000) return settingsCache.v;
  try {
    const r = await dv.get<any>(`msdyn_occustommessagingchannels(${cfg.d365ChannelId()})?$select=msdyn_enablefileattachmentsforcustomers,msdyn_enablefileattachmentsforagents`);
    const v = { customers: r.msdyn_enablefileattachmentsforcustomers === true, agents: r.msdyn_enablefileattachmentsforagents === true };
    settingsCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    console.warn(`attachment settings unavailable, treating as disabled: ${(e as Error).message}`);
    return { customers: false, agents: false };
  }
}

// ---------------------------------------------------------------- 019 file rules (send-whatsapp-file)
const MB = 1024 * 1024;
export const O19_FILE_RULES: Record<string, { ext: string[]; max: number }> = {
  image: { ext: ["jpg", "jpeg", "png", "gif"], max: 5 * MB },
  video: { ext: ["mp4", "avi", "3gpp"], max: 16 * MB },
  audio: { ext: ["mp3", "ogg", "amr", "aac"], max: 16 * MB },
  document: { ext: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "ppts", "zip", "txt", "rar"], max: 100 * MB },
};
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "video/3gpp": "3gpp", "video/x-msvideo": "avi",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/amr": "amr", "audio/aac": "aac", "application/pdf": "pdf", "text/plain": "txt",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppts",
  "application/zip": "zip", "application/x-zip-compressed": "zip", "application/vnd.rar": "rar", "application/x-rar-compressed": "rar",
};
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
EXT_MIME.jpeg = "image/jpeg";

export const extOf = (name: string) => (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
export const mimeOf = (name: string, fallback = "application/octet-stream") => EXT_MIME[extOf(name)] ?? fallback;

/** Picks a safe file name with an extension 019 accepts, or explains why the file can't be sent. */
export function checkForO19(name: string, contentType: string, size: number): { ok: true; name: string } | { ok: false; reason: string } {
  let file = (name || "file").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  let ext = extOf(file);
  if (!ext && MIME_EXT[contentType]) { ext = MIME_EXT[contentType]; file = `${file}.${ext}`; }
  const rule = Object.values(O19_FILE_RULES).find((r) => r.ext.includes(ext));
  if (!rule) return { ok: false, reason: `סוג הקובץ ${ext || contentType} אינו נתמך ב-WhatsApp` };
  if (size > rule.max) return { ok: false, reason: `הקובץ גדול מדי (${(size / MB).toFixed(1)}MB, מקסימום ${rule.max / MB}MB)` };
  return { ok: true, name: file };
}

// ---------------------------------------------------------------- download
export async function download(url: string, auth?: "d365" | "o19", maxBytes = 100 * MB): Promise<{ data: Buffer; contentType: string; name?: string }> {
  const headers: Record<string, string> = {};
  const attempt = async (h: Record<string, string>) => fetch(url, { headers: h, redirect: "follow" });
  let res = await attempt(headers);
  if ((res.status === 401 || res.status === 403) && auth) {
    const token = auth === "d365" ? await getToken(cfg.d365Scope()) : await secret(SECRETS.o19Token);
    res = await attempt({ Authorization: `Bearer ${token}` });
  }
  if (!res.ok) throw new Error(`download ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`too large: ${len}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`too large: ${data.length}`);
  const cd = res.headers.get("content-disposition") ?? "";
  const name = decodeURIComponent(cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? "") || undefined;
  return { data, contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim(), name };
}

// ---------------------------------------------------------------- private blob + signed public link
let container: ContainerClient | undefined;
async function media(): Promise<ContainerClient> {
  if (container) return container;
  const blobUrl = cfg.tableUrl().replace(".table.", ".blob.");
  container = new BlobServiceClient(blobUrl, credential).getContainerClient(cfg.mediaContainer());
  await container.createIfNotExists();
  return container;
}

const sign = async (path: string, exp: number) =>
  createHmac("sha256", `${await secret(SECRETS.pathSecret)}:media`).update(`${path}|${exp}`).digest("base64url");

/** Stores the file privately and returns a short-lived signed HTTPS link served by the adapter. */
export async function publishForO19(data: Buffer, name: string, contentType: string): Promise<string> {
  const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}/${name}`;
  await (await media()).getBlockBlobClient(path).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  const exp = Math.floor(Date.now() / 1000) + cfg.mediaLinkMinutes() * 60;
  const base = cfg.publicBaseUrl();
  return `${base}/api/media/${path.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${await sign(path, exp)}`;
}

/** Validates a signed link and returns the blob, or undefined. */
export async function openSigned(path: string, exp: number, sig: string): Promise<{ data: Buffer; contentType: string } | undefined> {
  if (!path || !exp || !sig || exp < Date.now() / 1000) return undefined;
  const expected = Buffer.from(await sign(path, exp));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined;
  const blob = (await media()).getBlockBlobClient(path);
  if (!(await blob.exists())) return undefined;
  const props = await blob.getProperties();
  return { data: await blob.downloadToBuffer(), contentType: props.contentType ?? mimeOf(path) };
}

/** Finds the media link in a 019 incoming push (019 sends it in `media` or `body`). */
export function mediaUrlOf(p: any): string | undefined {
  const isUrl = (v: unknown) => typeof v === "string" && /^https:\/\//i.test(v.trim());
  const m = p?.media;
  const candidates = [m?.url, m?.link, m?.href, typeof m === "string" ? m : undefined, p?.body, p?.link, p?.url];
  return (candidates.find(isUrl) as string | undefined)?.trim();
}
