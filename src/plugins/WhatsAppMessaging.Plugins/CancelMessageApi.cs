using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace WhatsAppMessaging.Plugins
{
    /// <summary>Custom API &lt;prefix&gt;_CancelWhatsAppMessage: cancels a message that is still Queued or Scheduled.</summary>
    public sealed class CancelMessageApi : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var ctx = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var svc = ((IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(ctx.UserId);
            var p = Messaging.PrefixFromName(ctx.MessageName);
            var table = p + Messaging.MessageTableSuffix;
            var id = ctx.InputParameters["MessageId"] is Guid g ? g : throw new InvalidPluginExecutionException("MessageId is required.");

            var elastic = Messaging.IsElastic(svc, table);
            var q = new QueryExpression(table) { ColumnSet = elastic ? new ColumnSet(p + "_messagestatus", "partitionid") : new ColumnSet(p + "_messagestatus"), TopCount = 1 };
            q.Criteria.AddCondition(table + "id", ConditionOperator.Equal, id);
            var row = svc.RetrieveMultiple(q).Entities.FirstOrDefault() ?? throw new InvalidPluginExecutionException($"Message {id} was not found.");
            var current = Messaging.ChoiceLabel(svc, table, p + "_messagestatus", row.GetAttributeValue<OptionSetValue>(p + "_messagestatus")?.Value ?? 0);

            if (current == "Queued" || current == "Scheduled")
            {
                var upd = Messaging.ForUpdate(svc, table, id, elastic ? row.GetAttributeValue<string>("partitionid") : null);
                upd[p + "_messagestatus"] = new OptionSetValue(Messaging.ChoiceValue(svc, table, p + "_messagestatus", "Canceled"));
                svc.Update(upd);
                current = "Canceled";
            }
            ctx.OutputParameters["Status"] = current;
        }
    }
}
