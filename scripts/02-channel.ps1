# Phase 1 – Adapter app user, workstream, context variables, Messaging API channel, managed identity + FIC (idempotent)
. (Join-Path $PSScriptRoot '_common.ps1')

$wsName = $Cfg.workstreamName
$webhookBase = "$($Cfg.adapterBaseUrl)/api/d365"
$rootBu = (Invoke-Dv -Path "businessunits?`$filter=parentbusinessunitid eq null&`$select=businessunitid").value[0].businessunitid

# 1) Dataverse application user for the adapter app (template sync / outbound log writes)
$appUser = (Invoke-Dv -Path "systemusers?`$filter=applicationid eq $($Cfg.adapterAppId)&`$select=systemuserid").value | Select-Object -First 1
if (-not $appUser) {
    $appUser = Invoke-Dv -Method POST -Path 'systemusers' -Body @{
        applicationid = $Cfg.adapterAppId; 'businessunitid@odata.bind' = "/businessunits($rootBu)"
        firstname = 'WhatsApp 019'; lastname = 'Adapter'
    }
    Write-Host "+ app user $($appUser.systemuserid)"
} else { Write-Host "= app user $($appUser.systemuserid)" }

# 2) Workstream (messaging / custom), modelled on the existing WhatsApp workstream
$ws = (Invoke-Dv -Path "msdyn_liveworkstreams?`$filter=msdyn_name eq '$wsName'&`$select=msdyn_liveworkstreamid").value | Select-Object -First 1
if (-not $ws) {
    $ws = Invoke-Dv -Method POST -Path 'msdyn_liveworkstreams' -Solution -Body @{
        msdyn_name                                  = $wsName
        msdyn_streamsource                          = 192350002      # Custom
        msdyn_mode                                  = 717210001      # Push (as WhatsApp)
        msdyn_conversationmode                      = 192350000
        msdyn_workdistributionmode                  = 192350000
        msdyn_capacityformat                        = 192350000
        msdyn_capacityrequired                      = 1
        msdyn_autocloseafterinactivity              = 1440           # 24h, aligned with WhatsApp window
        msdyn_allowedpresences                      = '192360000,192360001'
        msdyn_enableautomatedmessages               = $true
        msdyn_enableagentaffinity                   = $true
        msdyn_enableselectingfrompushbasedworkstreams = $true
        msdyn_notification                          = 100000001
        msdyn_screenpoptimeout_optionSet            = 120
        msdyn_sessiontemplate_default               = 'msdyn_custommessaging_session'
        msdyn_notificationtemplate_incoming_auth    = 'msdyn_custommessaging_incoming_authenticated'
        msdyn_notificationtemplate_incoming_unauth  = 'msdyn_custommessaging_incoming_unauthenticated'
        msdyn_notificationtemplate_consult          = 'msdyn_custommessaging_consult'
        msdyn_notificationtemplate_transfer         = 'msdyn_custommessaging_transfer'
        msdyn_notificationtemplate_supervisorassign = 'msdyn_custommessaging_supervisor_assign'
        'msdyn_defaultqueue@odata.bind'             = "/queues($($Cfg.defaultQueueId))"
        'msdyn_bot_user@odata.bind'                 = "/systemusers($($Cfg.botUserId))"
    }
    Write-Host "+ workstream $($ws.msdyn_liveworkstreamid)"
} else { Write-Host "= workstream $($ws.msdyn_liveworkstreamid)" }
$wsId = $ws.msdyn_liveworkstreamid

# 3) Context variables (spec §4.3) – Copilot Studio global variables must use identical names
$ctx = @(
    @{ n = 'wa_LineNumber'; t = 192350000; d = $false }, @{ n = 'wa_UserId'; t = 192350000; d = $false },
    @{ n = 'wa_ProfileName'; t = 192350000; d = $true }, @{ n = 'wa_EntryPoint'; t = 192350000; d = $true },
    @{ n = 'wa_TemplateName'; t = 192350000; d = $true }, @{ n = 'wa_CampaignId'; t = 192350000; d = $false },
    @{ n = 'wa_RelatedRecordId'; t = 192350000; d = $false }, @{ n = 'wa_Is24hWindowOpen'; t = 192350002; d = $false },
    @{ n = 'wa_LastInteraction'; t = 192350000; d = $false }
)
$existing = (Invoke-Dv -Path "msdyn_ocliveworkstreamcontextvariables?`$filter=_msdyn_liveworkstreamid_value eq $wsId&`$select=msdyn_name").value.msdyn_name
foreach ($c in $ctx) {
    if ($existing -contains $c.n) { Write-Host "  = ctx $($c.n)"; continue }
    Invoke-Dv -Method POST -Path 'msdyn_ocliveworkstreamcontextvariables' -Solution -Body @{
        msdyn_name = $c.n; msdyn_displayname = $c.n; msdyn_datatype = $c.t; msdyn_isdisplayable = $c.d
        msdyn_ismodifiable = $true; 'msdyn_liveworkstreamid@odata.bind' = "/msdyn_liveworkstreams($wsId)"
    } | Out-Null
    Write-Host "  + ctx $($c.n)"
}

# 4) Managed identity record (Power Platform -> Entra, used by D365 to call the adapter webhook)
$mi = (Invoke-Dv -Path "managedidentities?`$filter=applicationid eq $($Cfg.adapterAppId)&`$select=managedidentityid").value | Select-Object -First 1
if (-not $mi) {
    $mi = Invoke-Dv -Method POST -Path 'managedidentities' -Solution -Body @{
        applicationid = $Cfg.adapterAppId; tenantid = $Cfg.tenantId; credentialsource = 2; subjectscope = 1; name = 'wa019-adapter'
    }
    Write-Host "+ managedidentity $($mi.managedidentityid)"
} else { Write-Host "= managedidentity $($mi.managedidentityid)" }

# 5) Messaging API custom channel record
$heLang = (Invoke-Dv -Path "msdyn_oclanguages?`$filter=msdyn_localeid eq 1037&`$select=msdyn_oclanguageid").value[0].msdyn_oclanguageid
$ch = (Invoke-Dv -Path "msdyn_occustommessagingchannels?`$filter=msdyn_appid eq '$($Cfg.adapterAppId)'&`$select=msdyn_occustommessagingchannelid").value | Select-Object -First 1
$chBody = @{
    msdyn_name                               = 'WhatsApp (019)'
    msdyn_occustomchannelid                  = 192350005   # Messaging API
    msdyn_appid                              = $Cfg.adapterAppId
    msdyn_tenantid                           = $Cfg.tenantId
    msdyn_webhookurl                         = $webhookBase
    msdyn_enablefileattachmentsforagents     = $false       # phase 1: text only
    msdyn_enablefileattachmentsforcustomers  = $false
    'managedidentityid@odata.bind'           = "/managedidentities($($mi.managedidentityid))"
    'msdyn_liveworkstreamid@odata.bind'      = "/msdyn_liveworkstreams($wsId)"
    'msdyn_ocwidgetlanguage@odata.bind'      = "/msdyn_oclanguages($heLang)"
}
if (-not $ch) {
    $ch = Invoke-Dv -Method POST -Path 'msdyn_occustommessagingchannels' -Solution -Body $chBody
    Write-Host "+ channel $($ch.msdyn_occustommessagingchannelid)"
} else {
    Invoke-Dv -Method PATCH -Path "msdyn_occustommessagingchannels($($ch.msdyn_occustommessagingchannelid))" -Body $chBody | Out-Null
    Write-Host "= channel $($ch.msdyn_occustommessagingchannelid) (updated)"
}
$chId = $ch.msdyn_occustommessagingchannelid

# 6) Federated identity credential (must be refreshed after any webhook change)
$fic = Invoke-Dv -Path "GetComponentManagedIdentityFIC(ComponentName='msdyn_occustommessagingchannel',ComponentId=$chId)"
$subject = $fic.FICSubject
Write-Host "FIC subject: $subject"
$existingFic = az ad app federated-credential list --id $Cfg.adapterAppId --query "[?subject=='$subject'].name" -o tsv
if (-not $existingFic) {
    $ficFile = Join-Path $env:TEMP 'wa019-fic.json'
    @{ name = "d365-channel-$($chId.Substring(0,8))-$(Get-Date -Format yyyyMMddHHmm)"; issuer = "https://login.microsoftonline.com/$($Cfg.tenantId)/v2.0"; subject = $subject; audiences = @('api://AzureADTokenExchange'); description = 'D365 Messaging API webhook (managed identity)' } | ConvertTo-Json | Set-Content $ficFile
    az ad app federated-credential create --id $Cfg.adapterAppId --parameters "@$ficFile" -o none
    Remove-Item $ficFile
    Write-Host "+ federated credential"
} else { Write-Host "= federated credential $existingFic" }

$out = [ordered]@{ workstreamId = $wsId; channelId = $chId; managedIdentityId = $mi.managedidentityid; appUserId = $appUser.systemuserid; ficSubject = $subject }
$out | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'out.channel.json')
$out
