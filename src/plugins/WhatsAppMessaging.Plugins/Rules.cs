using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;

namespace WhatsAppMessaging.Plugins
{
    /// <summary>Pure request rules (no Dataverse dependency) so they can be unit-tested on any platform.</summary>
    public static class Rules
    {
        /// <summary>WhatsApp user IDs ("CC.123…") are kept; phone numbers are reduced to E.164 digits without '+'.</summary>
        public static string NormalizeRecipient(string to)
        {
            var s = (to ?? "").Trim();
            if (Regex.IsMatch(s, @"^[A-Za-z]{2}\.\d{6,}$")) return s.Substring(0, 2).ToUpperInvariant() + s.Substring(2);
            var digits = Regex.Replace(s, @"[^\d]", "");
            if (s.StartsWith("00")) digits = digits.Substring(2);
            if (digits.Length < 8 || digits.Length > 15 || digits.StartsWith("0"))
                throw new ArgumentException("To must be an international phone number (E.164, e.g. +14255550100) or a WhatsApp user ID.");
            return digits;
        }

        public static Dictionary<string, string> ParseVariables(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, string>();
            try
            {
                using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                    return (Dictionary<string, string>)Serializer().ReadObject(ms) ?? new Dictionary<string, string>();
            }
            catch (Exception)
            {
                throw new ArgumentException("Variables must be a JSON object of strings, e.g. {\"1\":\"Dana\",\"2\":\"10:00\"}.");
            }
        }

        public static string ToJson(Dictionary<string, string> vars)
        {
            using (var ms = new MemoryStream()) { Serializer().WriteObject(ms, vars ?? new Dictionary<string, string>()); return Encoding.UTF8.GetString(ms.ToArray()); }
        }

        public static void ValidateVariables(Dictionary<string, string> vars, int required)
        {
            for (var i = 1; i <= required; i++)
                if (vars == null || !vars.TryGetValue(i.ToString(), out var v) || string.IsNullOrWhiteSpace(v))
                    throw new ArgumentException($"Template variable {{{{{i}}}}} is required.");
        }

        public static bool IsScheduled(DateTime? scheduledOnUtc, DateTime nowUtc) => scheduledOnUtc.HasValue && scheduledOnUtc.Value > nowUtc.AddMinutes(1);

        private static DataContractJsonSerializer Serializer() =>
            new DataContractJsonSerializer(typeof(Dictionary<string, string>), new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true });
    }
}
