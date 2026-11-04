# Phase 3 – Copilot Studio: global variables (external sources can set) + WA topics, then publish (idempotent)
. (Join-Path $PSScriptRoot '_common.ps1')
$mcs = Join-Path (Split-Path $PSScriptRoot -Parent) 'copilot-studio'
$bot = $Cfg.botId
$prefix = $Cfg.botSchemaName

function Ensure-Component([string]$schema, [string]$name, [int]$type, [string]$data, [string]$description = '') {
    $existing = (Invoke-Dv -Path "botcomponents?`$filter=schemaname eq '$schema'&`$select=botcomponentid").value | Select-Object -First 1
    if ($existing) {
        Invoke-Dv -Method PATCH -Path "botcomponents($($existing.botcomponentid))" -Body @{ data = $data; name = $name; description = $description } | Out-Null
        Write-Host "= $schema (updated)"
    } else {
        Invoke-Dv -Method POST -Path 'botcomponents' -Solution -Body @{
            schemaname = $schema; name = $name; componenttype = $type; data = $data; description = $description
            'parentbotid@odata.bind' = "/bots($bot)"
        } | Out-Null
        Write-Host "+ $schema"
    }
}

# Global variables that Omnichannel context can set (must match workstream context variable names exactly)
foreach ($v in 'wa_LastInteraction', 'wa_UserId', 'wa_ProfileName', 'wa_EntryPoint', 'wa_TemplateName', 'wa_LineNumber') {
    $yaml = "kind: Variable`nname: $v`nscope: Conversation`nisExternalInitializationAllowed: true`nisOutputToExternalCallers: false`ninitializationTimeoutInMilliseconds: 0`n"
    Ensure-Component "$prefix.GlobalVariableComponent.$v" $v 12 $yaml
}

Ensure-Component "$prefix.topic.WAVariables" 'WA · Variables (types)' 9 ((Get-Content (Join-Path $mcs 'topic.WAVariables.yaml') -Raw -Encoding utf8).Replace('{{BOT_SCHEMA}}', $prefix)) 'Type declarations for WhatsApp global variables – never called'
Ensure-Component "$prefix.topic.WAAskWithOptions" 'WA · Ask with options' 9 ((Get-Content (Join-Path $mcs 'topic.WAAskWithOptions.yaml') -Raw -Encoding utf8).Replace('{{BOT_SCHEMA}}', $prefix)) 'WhatsApp 019 buttons/list component'
Ensure-Component "$prefix.topic.WADemoMenu" 'WA · Demo menu' 9 ((Get-Content (Join-Path $mcs 'topic.WADemoMenu.yaml') -Raw -Encoding utf8).Replace('{{BOT_SCHEMA}}', $prefix)) 'Demo of WhatsApp 019 buttons'

Write-Host "Publishing bot..."
$started = (Get-Date).ToUniversalTime()
Invoke-Dv -Method POST -Path "bots($bot)/Microsoft.Dynamics.CRM.PvaPublish" -Body @{} | Out-Null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep 15
    $s = (Invoke-Dv -Path "bots($bot)?`$select=synchronizationstatus").synchronizationstatus | ConvertFrom-Json
    $op = $s.lastFinishedPublishOperation
    if ($op -and [datetime]$op.operationEnd -gt $started) {
        Write-Host "Publish status: $($op.status)"
        foreach ($d in $op.diagnosticDetails) { foreach ($x in $d.diagnosticList) { Write-Host "  ! $($d.reference.dialogId)/$($d.reference.actionId): $($x.errorCode) $($x.errorMessage)" } }
        break
    }
}
