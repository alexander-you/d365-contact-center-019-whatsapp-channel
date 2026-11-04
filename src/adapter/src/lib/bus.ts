import { ServiceBusClient, ServiceBusSender } from "@azure/service-bus";
import { credential } from "./config";

let client: ServiceBusClient | undefined;
const senders = new Map<string, ServiceBusSender>();

function sender(queue: string): ServiceBusSender {
  client ??= new ServiceBusClient(process.env.ServiceBusConnection__fullyQualifiedNamespace!, credential);
  let s = senders.get(queue);
  if (!s) { s = client.createSender(queue); senders.set(queue, s); }
  return s;
}

export async function enqueue(queue: "sb-inbound" | "sb-outbound" | "sb-status", body: unknown, opts: { sessionId?: string; messageId?: string } = {}) {
  await sender(queue).sendMessages({ body, contentType: "application/json", sessionId: opts.sessionId, messageId: opts.messageId });
}
