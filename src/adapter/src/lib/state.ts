import { TableClient, odata } from "@azure/data-tables";
import { cfg, credential } from "./config";

const clients = new Map<string, TableClient>();
export function table(name: string): TableClient {
  let c = clients.get(name);
  if (!c) {
    c = new TableClient(cfg.tableUrl(), name, credential);
    clients.set(name, c);
  }
  return c;
}

const safe = (s: string) => s.replace(/[\/\\#?]/g, "_");

export async function getEntity<T extends object>(t: string, pk: string, rk: string): Promise<(T & { etag?: string }) | undefined> {
  try {
    return (await table(t).getEntity<T>(safe(pk), safe(rk))) as T & { etag?: string };
  } catch (e: any) {
    if (e?.statusCode === 404) return undefined;
    throw e;
  }
}

export async function upsert(t: string, pk: string, rk: string, data: Record<string, unknown>): Promise<void> {
  await table(t).upsertEntity({ partitionKey: safe(pk), rowKey: safe(rk), ...data }, "Merge");
}

export async function remove(t: string, pk: string, rk: string): Promise<void> {
  try { await table(t).deleteEntity(safe(pk), safe(rk)); } catch (e: any) { if (e?.statusCode !== 404) throw e; }
}

/** Returns true if the key was newly recorded (i.e. not a duplicate). */
export async function firstSeen(source: string, id: string): Promise<boolean> {
  try {
    await table("Dedupe").createEntity({ partitionKey: safe(source), rowKey: safe(id), at: new Date().toISOString() });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 409) return false;
    throw e;
  }
}

export async function query<T extends object>(t: string, filter: string, top = 50): Promise<T[]> {
  const out: T[] = [];
  for await (const e of table(t).listEntities<T>({ queryOptions: { filter } })) {
    out.push(e as T);
    if (out.length >= top) break;
  }
  return out;
}

export { odata };

// ---- Typed accessors ---------------------------------------------------------
export interface ConversationRow {
  conversationId: string;
  state: "Active" | "Closed";
  lastInboundUtc?: string;
  phone?: string;
  profileName?: string;
  createdUtc?: string;
}

export const Conversations = {
  get: (line: string, waUserId: string) => getEntity<ConversationRow>("Conversations", line, waUserId),
  set: async (line: string, waUserId: string, row: Partial<ConversationRow>) => {
    await upsert("Conversations", line, waUserId, row);
    if (row.conversationId) await upsert("ConvIndex", "conv", row.conversationId, { line, waUserId });
  },
  byConversation: async (conversationId: string) => {
    const ix = await getEntity<{ line: string; waUserId: string }>("ConvIndex", "conv", conversationId);
    if (!ix) return undefined;
    const row = await Conversations.get(ix.line, ix.waUserId);
    return row ? { ...row, line: ix.line, waUserId: ix.waUserId } : undefined;
  },
};
