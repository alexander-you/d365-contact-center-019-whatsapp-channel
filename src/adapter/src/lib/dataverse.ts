import { cfg } from "./config";
import { getToken } from "./auth";

/** Minimal Dataverse Web API client (app-only, adapter app user). */
async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const base = cfg.dataverseUrl();
  if (!base) throw new Error("DATAVERSE_URL not configured");
  const token = await getToken(`${base}/.default`);
  const res = await fetch(`${base}/api/data/v9.2/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json; charset=utf-8",
      "OData-MaxVersion": "4.0", "OData-Version": "4.0", Prefer: "return=representation", ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dataverse ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export const dv = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown, headers?: Record<string, string>) => call<T>("PATCH", path, body, headers),
};

// Choice values (publisher option prefix 62621)
export const CH = {
  status: { approved: 626210000, pending: 626210001, rejected: 626210002, paused: 626210003, banned: 626210004, flagged: 626210005, deleted: 626210006 },
  category: { utility: 626210000, marketing: 626210001, authentication: 626210002 },
  delivery: { queued: 626210000, sent: 626210001, delivered: 626210002, read: 626210003, failed: 626210004, replied: 626210005 },
  usage: { agent: 626210000, automation: 626210001, bot: 626210002, campaign: 626210003 },
};

/** 019 template status code -> Dataverse choice. Docs: 0 pending, 1 approved, 2-5 rejected, 6 paused, 7 banned, 9 deleted, 10 flagged, 11 unflagged. */
export function mapTemplateStatus(code: number): number {
  if (code === 1 || code === 11 || code === 8) return CH.status.approved;
  if (code === 0) return CH.status.pending;
  if (code >= 2 && code <= 5) return CH.status.rejected;
  if (code === 6) return CH.status.paused;
  if (code === 7) return CH.status.banned;
  if (code === 9) return CH.status.deleted;
  if (code === 10) return CH.status.flagged;
  return CH.status.pending;
}
