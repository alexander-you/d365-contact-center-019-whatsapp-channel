import { app, InvocationContext } from "@azure/functions";
import { processInbound, processOutbound, processStatus } from "../lib/processors";
import { processQueuedMessage } from "../lib/outbound";

// Sessions guarantee FIFO per WhatsApp user (inbound) and per conversation (outbound). Spec §12.1
app.serviceBusQueue("ProcInbound", {
  queueName: "sb-inbound", connection: "ServiceBusConnection", isSessionsEnabled: true,
  handler: async (msg: unknown, ctx: InvocationContext) => processInbound(msg as any, ctx),
});

app.serviceBusQueue("ProcOutbound", {
  queueName: "sb-outbound", connection: "ServiceBusConnection", isSessionsEnabled: true,
  handler: async (msg: unknown, ctx: InvocationContext) => {
    const m = msg as { conversationId: string; activity: any };
    await processOutbound(m.conversationId, m.activity, ctx);
  },
});

app.serviceBusQueue("ProcStatus", {
  queueName: "sb-status", connection: "ServiceBusConnection",
  handler: async (msg: unknown, ctx: InvocationContext) => processStatus(msg as any, ctx),
});

// Outbound message requests: the Dataverse plug-in enqueues the WhatsApp Message row id (optionally scheduled)
app.serviceBusQueue("ProcTemplate", {
  queueName: "sb-template", connection: "ServiceBusConnection",
  handler: async (msg: unknown, ctx: InvocationContext) => {
    const m = (typeof msg === "string" ? JSON.parse(msg) : msg) as { id: string; partitionId?: string };
    await processQueuedMessage(m, Number((ctx.triggerMetadata as any)?.deliveryCount ?? 1), ctx);
  },
});
