import { cfg } from "./config";
import { getToken } from "./auth";

/** Dynamics 365 Contact Center Messaging API client (docs: /api/v1.0/consumer/...). */
export class D365Error extends Error {
  constructor(public status: number, public body: string) { super(`D365 ${status}: ${body.slice(0, 300)}`); }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, attempt = 0): Promise<T> {
  const token = await getToken(cfg.d365Scope());
  const res = await fetch(`${cfg.d365BaseUrl()}/api/v1.0/consumer${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "channel-id": cfg.d365ChannelId(),
      "organization-id": cfg.d365OrgId(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok) return (text ? JSON.parse(text) : {}) as T;
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return call<T>(method, path, body, attempt + 1);
  }
  throw new D365Error(res.status, text);
}

type Displayable = { isDisplayable: boolean; value: string | number | boolean };

export interface CreateConversation {
  customercontext: { customerid?: string; firstname?: string; lastname?: string; preferredname?: string; email?: string; phonenumber?: string };
  conversationcontext?: Record<string, Displayable>;
  conversationrequestid?: string;
  startmessage?: { message: string; displayname?: string };
  skipdeflectionbot?: boolean;
}

export const d365 = {
  createConversation: (b: CreateConversation) =>
    call<{ conversationId: string; isNew: boolean; messageId?: string }>("POST", "/conversation/create", b),

  sendMessage: (conversationId: string, m: { text?: string; from?: { id: string; name?: string }; value?: unknown; channelData?: unknown; automated?: boolean; attachments?: unknown[] }) => {
    const channelData: Record<string, unknown> = { ...(m.channelData as object ?? {}) };
    if (m.automated) channelData["messagingapi-oc"] = { type: "AutomatedMessage" };
    return call<{ messageId: string }>("POST", `/conversation/${conversationId}`, {
      type: "message",
      channelId: cfg.d365ChannelId(),
      conversation: { id: conversationId },
      from: m.from,
      text: m.text,
      value: m.value,
      attachments: m.attachments ?? [],
      channelData: Object.keys(channelData).length ? channelData : undefined,
    });
  },

  /** Custom event → updates context variables (setContextProvider format). */
  customEvent: (conversationId: string, name: string, vars: Record<string, Displayable>) =>
    call<{ messageId: string }>("POST", `/conversation/${conversationId}`, {
      type: "event",
      name,
      channelId: cfg.d365ChannelId(),
      conversation: { id: conversationId },
      channelData: { customEvent: true, customEventName: name, customEventValue: JSON.stringify(vars) },
    }),

  typing: (conversationId: string, name?: string) =>
    call("POST", `/conversation/${conversationId}`, { type: "typing", channelId: cfg.d365ChannelId(), from: { name }, conversation: { id: conversationId } }),

  read: (conversationId: string, messageId: string) =>
    call("POST", `/conversation/${conversationId}`, {
      type: "event", name: "MessageRead", channelId: cfg.d365ChannelId(), conversation: { id: conversationId }, value: { messageId },
    }),

  end: (conversationId: string) =>
    call("POST", `/conversation/${conversationId}`, { type: "endOfConversation", channelId: cfg.d365ChannelId(), conversation: { id: conversationId } }),

  messages: (conversationId: string, startIso?: string, pageSize = 20) =>
    call<{ messages: Array<{ messageId: string; timestamp: string; text?: string; from?: { id?: string; name?: string; role?: string }; channelData?: any }> }>(
      "GET", `/conversation/${conversationId}/messages?PageSize=${pageSize}${startIso ? `&StartTimeStamp=${encodeURIComponent(startIso)}` : ""}`),

  activeConversations: () => call<{ conversations: Array<{ conversationid: string; timestamp: string }> }>("GET", "/conversations?PageSize=250"),
};
