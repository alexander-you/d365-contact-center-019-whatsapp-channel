using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;

namespace WhatsAppMessaging.Plugins
{
    /// <summary>Shared rules, settings and metadata helpers. The publisher prefix is derived from the message or table name, so the assembly is customer-agnostic.</summary>
    public static class Messaging
    {
        public const string MessageTableSuffix = "_wamessage";
        public const string TemplateTableSuffix = "_watemplate";

        public static string PrefixFromName(string name)
        {
            var i = (name ?? "").IndexOf('_');
            if (i <= 0) throw new InvalidPluginExecutionException($"Cannot derive publisher prefix from '{name}'.");
            return name.Substring(0, i).ToLowerInvariant();
        }

        // Request rules live in Rules.cs (no Dataverse dependency, unit-tested); here they surface as plug-in errors.
        public static string NormalizeRecipient(string to) => Guard(() => Rules.NormalizeRecipient(to));
        public static Dictionary<string, string> ParseVariables(string json) => Guard(() => Rules.ParseVariables(json));
        public static string ToJson(Dictionary<string, string> vars) => Rules.ToJson(vars);
        public static void ValidateVariables(Dictionary<string, string> vars, int required) => Guard(() => { Rules.ValidateVariables(vars, required); return true; });

        private static T Guard<T>(Func<T> f)
        {
            try { return f(); } catch (ArgumentException e) { throw new InvalidPluginExecutionException(e.Message); }
        }

        // ---------------------------------------------------------------- environment variables
        public static string Setting(IOrganizationService svc, string prefix, string name, string fallback = null)
        {
            var schema = $"{prefix}_{name}";
            var q = new QueryExpression("environmentvariabledefinition") { ColumnSet = new ColumnSet("defaultvalue"), TopCount = 1 };
            q.Criteria.AddCondition("schemaname", ConditionOperator.Equal, schema);
            var link = q.AddLink("environmentvariablevalue", "environmentvariabledefinitionid", "environmentvariabledefinitionid", JoinOperator.LeftOuter);
            link.EntityAlias = "v"; link.Columns = new ColumnSet("value");
            var row = svc.RetrieveMultiple(q).Entities.FirstOrDefault();
            if (row == null) return fallback;
            var val = (row.GetAttributeValue<AliasedValue>("v.value")?.Value as string) ?? row.GetAttributeValue<string>("defaultvalue");
            return string.IsNullOrWhiteSpace(val) ? fallback : val.Trim();
        }

        // ---------------------------------------------------------------- choice labels <-> values (English labels, cached per AppDomain)
        private static readonly Dictionary<string, Dictionary<string, int>> ChoiceCache = new Dictionary<string, Dictionary<string, int>>();

        private static Dictionary<string, int> Choices(IOrganizationService svc, string table, string column)
        {
            var key = $"{table}.{column}";
            lock (ChoiceCache)
            {
                if (ChoiceCache.TryGetValue(key, out var cached)) return cached;
                var resp = (RetrieveAttributeResponse)svc.Execute(new RetrieveAttributeRequest { EntityLogicalName = table, LogicalName = column });
                var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (var o in ((EnumAttributeMetadata)resp.AttributeMetadata).OptionSet.Options)
                {
                    var label = o.Label.LocalizedLabels.FirstOrDefault(l => l.LanguageCode == 1033) ?? o.Label.LocalizedLabels.FirstOrDefault();
                    if (label != null && o.Value.HasValue) map[label.Label] = o.Value.Value;
                }
                ChoiceCache[key] = map;
                return map;
            }
        }

        public static int ChoiceValue(IOrganizationService svc, string table, string column, string label)
        {
            if (!Choices(svc, table, column).TryGetValue(label, out var value)) throw new InvalidPluginExecutionException($"Choice '{label}' not found on {table}.{column}.");
            return value;
        }

        public static string ChoiceLabel(IOrganizationService svc, string table, string column, int value) =>
            Choices(svc, table, column).FirstOrDefault(kv => kv.Value == value).Key;

        // ---------------------------------------------------------------- table type (Elastic preferred; Standard supported)
        // Cached per worker for a few minutes only, so that recreating the table (Standard -> Elastic) is picked up.
        private static readonly Dictionary<string, KeyValuePair<bool, DateTime>> ElasticCache = new Dictionary<string, KeyValuePair<bool, DateTime>>();
        private static readonly TimeSpan ElasticCacheTtl = TimeSpan.FromMinutes(5);

        public static bool IsElastic(IOrganizationService svc, string table)
        {
            lock (ElasticCache)
            {
                if (ElasticCache.TryGetValue(table, out var c) && c.Value > DateTime.UtcNow) return c.Key;
                var resp = (RetrieveEntityResponse)svc.Execute(new RetrieveEntityRequest { LogicalName = table, EntityFilters = EntityFilters.Entity });
                var e = string.Equals(resp.EntityMetadata.TableType, "Elastic", StringComparison.OrdinalIgnoreCase);
                ElasticCache[table] = new KeyValuePair<bool, DateTime>(e, DateTime.UtcNow + ElasticCacheTtl);
                return e;
            }
        }

        /// <summary>Reference for update: elastic rows with a partition are addressed by (id, partitionid).</summary>
        public static Entity ForUpdate(IOrganizationService svc, string table, Guid id, string partitionId)
        {
            if (IsElastic(svc, table) && !string.IsNullOrEmpty(partitionId))
                return new Entity(table) { KeyAttributes = { { table + "id", id }, { "partitionid", partitionId } } };
            return new Entity(table, id);
        }
    }
}
