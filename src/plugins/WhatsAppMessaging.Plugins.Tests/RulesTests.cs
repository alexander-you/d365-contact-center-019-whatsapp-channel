using System;
using System.Collections.Generic;
using WhatsAppMessaging.Plugins;
using Xunit;

public class RulesTests
{
    [Theory]
    [InlineData("+1 (425) 555-0100", "14255550100")]
    [InlineData("00447700900123", "447700900123")]
    [InlineData("il.123456789012", "IL.123456789012")]
    public void NormalizesRecipients(string input, string expected) => Assert.Equal(expected, Rules.NormalizeRecipient(input));

    [Theory]
    [InlineData("0501234567")]
    [InlineData("12345")]
    [InlineData("")]
    public void RejectsLocalOrInvalidNumbers(string input) => Assert.Throws<ArgumentException>(() => Rules.NormalizeRecipient(input));

    [Fact]
    public void ParsesAndSerializesVariables()
    {
        var v = Rules.ParseVariables("{\"1\":\"Dana\",\"2\":\"10:00\"}");
        Assert.Equal("Dana", v["1"]);
        Assert.Contains("\"2\":\"10:00\"", Rules.ToJson(v));
        Assert.Empty(Rules.ParseVariables(" "));
        Assert.Throws<ArgumentException>(() => Rules.ParseVariables("[1,2]"));
    }

    [Fact]
    public void ValidatesRequiredVariables()
    {
        Rules.ValidateVariables(new Dictionary<string, string> { ["1"] = "a", ["2"] = "b" }, 2);
        Assert.Throws<ArgumentException>(() => Rules.ValidateVariables(new Dictionary<string, string> { ["1"] = "a" }, 2));
        Assert.Throws<ArgumentException>(() => Rules.ValidateVariables(new Dictionary<string, string> { ["1"] = " " }, 1));
    }

    [Fact]
    public void DetectsScheduledSends()
    {
        var now = new DateTime(2030, 1, 1, 12, 0, 0, DateTimeKind.Utc);
        Assert.True(Rules.IsScheduled(now.AddHours(1), now));
        Assert.False(Rules.IsScheduled(now.AddSeconds(30), now));
        Assert.False(Rules.IsScheduled(null, now));
    }
}