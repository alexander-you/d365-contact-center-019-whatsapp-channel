using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace WhatsAppMessaging.Plugins
{
    /// <summary>
    /// Custom API &lt;prefix&gt;_SendWhatsAppMessage (unbound action).
    /// Validates the request and creates a row in the WhatsApp Message elastic table with status Queued or Scheduled.
    /// Delivery is triggered by <see cref="EnqueueMessage"/> on that row.
    /// </summary>
    public sealed class SendMessageApi : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var ctx = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var trace = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var svc = ((IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(ctx.UserId);

            var p = Messaging.PrefixFromName(ctx.MessageName);
            var table = p + Messaging.MessageTableSuffix;
            string In(string name) => ctx.InputParameters.Contains(name) ? ctx.InputParameters[name] as string : null;

            var to = Messaging.NormalizeRecipient(In("To"));
            var templateKey = (In("Template") ?? "").Trim();
            if (templateKey.Length == 0) throw new InvalidPluginExecutionException("Template is required (template name or 019 template id).");
            var line = (In("Line") ?? Messaging.Setting(svc, p, "WaDefaultLine") ?? "").Trim();
            if (line.Length == 0) throw new InvalidPluginExecutionException("Line is required (no default line configured in environment variable " + p + "_WaDefaultLine).");

            // Idempotency (elastic tables have no alternate keys)
            var idem = In("IdempotencyKey");
            if (!string.IsNullOrWhiteSpace(idem))
            {
                var q = new QueryExpression(table) { ColumnSet = new ColumnSet(p + "_messagestatus"), TopCount = 1 };
                q.Criteria.AddCondition(p + "_idempotencykey", ConditionOperator.Equal, idem);
                var existing = svc.RetrieveMultiple(q).Entities.FirstOrDefault();
                if (existing != null)
                {
                    ctx.OutputParameters["MessageId"] = existing.Id;
                    ctx.OutputParameters["Status"] = Messaging.ChoiceLabel(svc, table, p + "_messagestatus", existing.GetAttributeValue<OptionSetValue>(p + "_messagestatus")?.Value ?? 0);
                    trace.Trace("Idempotent hit {0}", existing.Id);
                    return;
                }
            }

            // Template must exist on the line and be approved
            var tq = new QueryExpression(p + Messaging.TemplateTableSuffix) { ColumnSet = new ColumnSet(p + "_name", p + "_templateid", p + "_variablecount", p + "_status"), TopCount = 1 };
            tq.Criteria.AddCondition(p + "_linenumber", ConditionOperator.Equal, line);
            var or = new FilterExpression(LogicalOperator.Or);
            or.AddCondition(p + "_name", ConditionOperator.Equal, templateKey);
            or.AddCondition(p + "_templateid", ConditionOperator.Equal, templateKey);
            tq.Criteria.AddFilter(or);
            var tpl = svc.RetrieveMultiple(tq).Entities.FirstOrDefault()
                ?? throw new InvalidPluginExecutionException($"Template '{templateKey}' was not found for line {line}.");
            var approved = Messaging.ChoiceValue(svc, p + Messaging.TemplateTableSuffix, p + "_status", "Approved");
            if (tpl.GetAttributeValue<OptionSetValue>(p + "_status")?.Value != approved)
                throw new InvalidPluginExecutionException($"Template '{tpl.GetAttributeValue<string>(p + "_name")}' is not approved.");

            var vars = Messaging.ParseVariables(In("Variables"));
            Messaging.ValidateVariables(vars, tpl.GetAttributeValue<int?>(p + "_variablecount") ?? 0);

            var scheduledOn = ctx.InputParameters.Contains("ScheduledOn") ? ctx.InputParameters["ScheduledOn"] as DateTime? : null;
            var scheduled = scheduledOn.HasValue && Rules.IsScheduled(scheduledOn.Value.ToUniversalTime(), DateTime.UtcNow);
            var status = scheduled ? "Scheduled" : "Queued";
            var source = string.IsNullOrWhiteSpace(In("Source")) ? "API" : In("Source");
            var retentionDays = int.TryParse(Messaging.Setting(svc, p, "WaRetentionDays", "365"), out var d) ? d : 365;

            var row = new Entity(table)
            {
                [p + "_name"] = $"{tpl.GetAttributeValue<string>(p + "_name")} → {to}",
                [p + "_to"] = to,
                [p + "_linenumber"] = line,
                [p + "_template"] = templateKey,
                [p + "_templateid"] = tpl.GetAttributeValue<string>(p + "_templateid"),
                [p + "_templatename"] = tpl.GetAttributeValue<string>(p + "_name"),
                [p + "_variables"] = Messaging.ToJson(vars),
                [p + "_messagestatus"] = new OptionSetValue(Messaging.ChoiceValue(svc, table, p + "_messagestatus", status)),
                [p + "_source"] = new OptionSetValue(Messaging.ChoiceValue(svc, table, p + "_source", source)),
                [p + "_attempts"] = 0,
                [p + "_createtimelineactivity"] = ctx.InputParameters.Contains("CreateTimelineActivity") && (ctx.InputParameters["CreateTimelineActivity"] as bool? ?? false),
            };
            if (Messaging.IsElastic(svc, table))
            {
                row["partitionid"] = to;
                if (retentionDays > 0) row["ttlinseconds"] = retentionDays * 86400;
            }
            if (scheduled) row[p + "_scheduledon"] = scheduledOn.Value;
            if (!string.IsNullOrWhiteSpace(idem)) row[p + "_idempotencykey"] = idem;
            if (!string.IsNullOrWhiteSpace(In("CampaignId"))) row[p + "_campaignid"] = In("CampaignId");
            if (!string.IsNullOrWhiteSpace(In("ConversationId"))) row[p + "_conversationid"] = In("ConversationId");
            if (ctx.InputParameters.Contains("RelatedRecord") && ctx.InputParameters["RelatedRecord"] is EntityReference rel)
            {
                row[p + "_relatedentity"] = rel.LogicalName;
                row[p + "_relatedrecordid"] = rel.Id.ToString();
            }

            var id = svc.Create(row);
            trace.Trace("Created {0} {1} ({2})", table, id, status);
            ctx.OutputParameters["MessageId"] = id;
            ctx.OutputParameters["Status"] = status;
        }
    }
}
