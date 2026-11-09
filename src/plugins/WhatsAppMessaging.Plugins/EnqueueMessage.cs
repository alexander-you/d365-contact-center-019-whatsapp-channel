using System;
using System.Globalization;
using System.Net.Http;
using System.Text;
using Microsoft.Xrm.Sdk;

namespace WhatsAppMessaging.Plugins
{
    /// <summary>
    /// Async step on Create / Update(status) of the WhatsApp Message elastic table.
    /// When a row is Queued or Scheduled, posts a delivery request to Azure Service Bus using Power Platform managed identity (no secrets).
    /// Environment variables: &lt;prefix&gt;_WaServiceBusNamespace (e.g. sb-name.servicebus.windows.net), &lt;prefix&gt;_WaQueueName (default sb-template).
    /// </summary>
    public sealed class EnqueueMessage : IPlugin
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        public void Execute(IServiceProvider serviceProvider)
        {
            var ctx = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var trace = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var svc = ((IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(null);
            var table = ctx.PrimaryEntityName;
            var p = Messaging.PrefixFromName(table);

            var target = ctx.InputParameters.Contains("Target") ? ctx.InputParameters["Target"] as Entity : null;
            var image = ctx.PostEntityImages.Contains("post") ? ctx.PostEntityImages["post"] : null;
            Entity Pick(string col) => target != null && target.Contains(col) ? target : image;

            var status = Pick(p + "_messagestatus")?.GetAttributeValue<OptionSetValue>(p + "_messagestatus")?.Value;
            var label = status.HasValue ? Messaging.ChoiceLabel(svc, table, p + "_messagestatus", status.Value) : null;
            if (label != "Queued" && label != "Scheduled") { trace.Trace("Status {0}: nothing to enqueue", label); return; }

            var partition = target?.GetAttributeValue<string>("partitionid")
                ?? (target != null && target.KeyAttributes.Contains("partitionid") ? target.KeyAttributes["partitionid"] as string : null)
                ?? "";
            var scheduledOn = Pick(p + "_scheduledon")?.GetAttributeValue<DateTime?>(p + "_scheduledon");

            var ns = Messaging.Setting(svc, p, "WaServiceBusNamespace") ?? throw new InvalidPluginExecutionException($"Environment variable {p}_WaServiceBusNamespace is not set.");
            var queue = Messaging.Setting(svc, p, "WaQueueName", "sb-template");
            var mi = (IManagedIdentityService)serviceProvider.GetService(typeof(IManagedIdentityService));
            var token = mi.AcquireToken(new[] { "https://servicebus.azure.net/.default" });

            var broker = new StringBuilder("{\"MessageId\":\"").Append(ctx.PrimaryEntityId).Append('-').Append(DateTime.UtcNow.Ticks).Append('"');
            if (label == "Scheduled" && scheduledOn.HasValue && scheduledOn.Value.ToUniversalTime() > DateTime.UtcNow)
                broker.Append(",\"ScheduledEnqueueTimeUtc\":\"").Append(scheduledOn.Value.ToUniversalTime().ToString("R", CultureInfo.InvariantCulture)).Append('"');
            broker.Append('}');

            var body = "{\"id\":\"" + ctx.PrimaryEntityId + "\",\"partitionId\":\"" + Escape(partition) + "\",\"table\":\"" + table + "\"}";
            var req = new HttpRequestMessage(HttpMethod.Post, $"https://{ns.Replace("https://", "").TrimEnd('/')}/{queue}/messages")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            req.Headers.TryAddWithoutValidation("BrokerProperties", broker.ToString());

            var res = Http.SendAsync(req).GetAwaiter().GetResult();
            if (!res.IsSuccessStatusCode)
                throw new InvalidPluginExecutionException($"Service Bus enqueue failed: {(int)res.StatusCode} {res.Content.ReadAsStringAsync().GetAwaiter().GetResult()}");
            trace.Trace("Enqueued {0} ({1}) to {2}", ctx.PrimaryEntityId, label, queue);
        }

        private static string Escape(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
