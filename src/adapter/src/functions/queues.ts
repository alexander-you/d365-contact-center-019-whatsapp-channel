import { app, InvocationContext } from "@azure/functions";
import { processInbound, processOutbound, processStatus } from "../lib/processors";

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
