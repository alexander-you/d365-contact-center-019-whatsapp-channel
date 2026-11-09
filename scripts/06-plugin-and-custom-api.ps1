# Outbound messaging – plug-in, Custom APIs, async trigger and Power Platform managed identity (idempotent)
#
#   1. Environment variables (<prefix>_WaServiceBusNamespace, _WaQueueName, _WaDefaultLine, _WaRetentionDays)
#   2. Signs and registers the plug-in assembly (strong name + Authenticode certificate)
#   3. Custom APIs: <prefix>_SendWhatsAppMessage, <prefix>_CancelWhatsAppMessage
#   4. Async steps on the WhatsApp Message elastic table (Create, Update of status/schedule) -> Service Bus
#   5. Entra app for the plug-in identity + federated credential (version 2) + Dataverse managedidentity record
#   6. Azure Service Bus Data Sender on the template queue (no SAS keys, no secrets)
#
# Usage:
#   ./06-plugin-and-custom-api.ps1 -CertificatePath .\signing.pfx -CertificatePassword (Read-Host -AsSecureString)
#   ./06-plugin-and-custom-api.ps1 -DevCertificate      # self-signed certificate for development/test only
param(
    [string]$CertificatePath,
    [securestring]$CertificatePassword,
    [switch]$DevCertificate,
    [string]$AssemblyPath = (Join-Path $PSScriptRoot '..\src\plugins\WhatsAppMessaging.Plugins\bin\Release\net462\WhatsAppMessaging.Plugins.dll'),
    [switch]$Build
)
. (Join-Path $PSScriptRoot '_common.ps1')
$p = $Cfg.prefix
$msgTable = "${p}_wamessage"
if ($Cfg.azureSubscription) { az account set --subscription $Cfg.azureSubscription | Out-Null }

# ---------------------------------------------------------------- 1. environment variables
function Ensure-EnvVar([string]$name, [string]$display, [string]$default, [string]$value, [int]$type = 100000000) {
    $schema = "${p}_$name"
    $def = (Invoke-Dv -Path "environmentvariabledefinitions?`$filter=schemaname eq '$schema'&`$select=environmentvariabledefinitionid").value | Select-Object -First 1
    if (-not $def) {
        $def = Invoke-Dv -Method POST -Path 'environmentvariabledefinitions' -Solution -Body @{ schemaname = $schema; displayname = $display; type = $type; defaultvalue = $default }
        Write-Host "+ env var $schema"
    }
    if ($value) {
        $v = (Invoke-Dv -Path "environmentvariablevalues?`$filter=_environmentvariabledefinitionid_value eq $($def.environmentvariabledefinitionid)&`$select=environmentvariablevalueid").value | Select-Object -First 1
        if ($v) { Invoke-Dv -Method PATCH -Path "environmentvariablevalues($($v.environmentvariablevalueid))" -Body @{ value = $value } | Out-Null }
        else { Invoke-Dv -Method POST -Path 'environmentvariablevalues' -Solution -Body @{ schemaname = "${schema}_value"; value = $value; 'EnvironmentVariableDefinitionId@odata.bind' = "/environmentvariabledefinitions($($def.environmentvariabledefinitionid))" } | Out-Null }
        Write-Host "  = $schema = $value"
    }
}
Ensure-EnvVar 'WaServiceBusNamespace' 'WhatsApp – Service Bus namespace host' '' "$($Cfg.serviceBusName).servicebus.windows.net"
Ensure-EnvVar 'WaQueueName' 'WhatsApp – outbound queue name' 'sb-template' $Cfg.templateQueue
Ensure-EnvVar 'WaDefaultLine' 'WhatsApp – default business line' '' $Cfg.defaultLine
Ensure-EnvVar 'WaRetentionDays' 'WhatsApp – message retention (days, 0 = keep)' '365' "$($Cfg.messageRetentionDays)"

# ---------------------------------------------------------------- 2. sign + register assembly
$projDir = Join-Path $PSScriptRoot '..\src\plugins\WhatsAppMessaging.Plugins'
if ($Build -or -not (Test-Path $AssemblyPath)) {
    # Dataverse requires a strong-named assembly. The key is generated locally once and never committed (*.snk is git-ignored).
    $snk = Join-Path $projDir 'WhatsAppMessaging.Plugins.snk'
    if (-not (Test-Path $snk)) {
        $rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048)
        [IO.File]::WriteAllBytes($snk, $rsa.ExportCspBlob($true)); $rsa.Dispose()
        Write-Host "+ strong-name key $snk"
    }
    dotnet build $projDir -c Release --nologo -v q
    if ($LASTEXITCODE) { throw 'Plug-in build failed' }
}
if (-not (Test-Path $AssemblyPath)) { throw "Plug-in assembly not found: $AssemblyPath" }
if ($DevCertificate) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=WhatsApp Messaging Plugins (development)' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $cert) { $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=WhatsApp Messaging Plugins (development)' -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(2) }
    Write-Warning 'Using a self-signed certificate (development/test only).'
} elseif ($CertificatePath) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath, $CertificatePassword, 'Exportable')
} else { throw 'Specify -CertificatePath (production) or -DevCertificate (development).' }
$signed = Set-AuthenticodeSignature -FilePath $AssemblyPath -Certificate $cert -HashAlgorithm SHA256
if ($signed.Status -notin 'Valid', 'UnknownError') { Write-Warning "Signature status: $($signed.Status) $($signed.StatusMessage)" }

$asmName = [IO.Path]::GetFileNameWithoutExtension($AssemblyPath)
$content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($AssemblyPath))
$asm = (Invoke-Dv -Path "pluginassemblies?`$filter=name eq '$asmName'&`$select=pluginassemblyid").value | Select-Object -First 1
if ($asm) { Invoke-Dv -Method PATCH -Path "pluginassemblies($($asm.pluginassemblyid))" -Body @{ content = $content } | Out-Null; Write-Host "= assembly updated" }
else {
    $asm = Invoke-Dv -Method POST -Path 'pluginassemblies' -Solution -Body @{ name = $asmName; content = $content; isolationmode = 2; sourcetype = 0; culture = 'neutral' }
    Write-Host "+ assembly $($asm.pluginassemblyid)"
}
$asmId = $asm.pluginassemblyid

function Ensure-PluginType([string]$class, [string]$friendly) {
    $tn = "WhatsAppMessaging.Plugins.$class"
    $t = (Invoke-Dv -Path "plugintypes?`$filter=typename eq '$tn'&`$select=plugintypeid").value | Select-Object -First 1
    if (-not $t) { $t = Invoke-Dv -Method POST -Path 'plugintypes' -Solution -Body @{ typename = $tn; name = $tn; friendlyname = $friendly; 'pluginassemblyid@odata.bind' = "/pluginassemblies($asmId)" }; Write-Host "+ type $class" }
    $t.plugintypeid
}
$tSend = Ensure-PluginType 'SendMessageApi' 'WhatsApp – Send message (Custom API)'
$tCancel = Ensure-PluginType 'CancelMessageApi' 'WhatsApp – Cancel message (Custom API)'
$tEnqueue = Ensure-PluginType 'EnqueueMessage' 'WhatsApp – Enqueue message (Service Bus)'

# ---------------------------------------------------------------- 3. Custom APIs
# Parameter types: 0 Boolean, 1 DateTime, 5 EntityReference, 10 String, 12 Guid
function Ensure-CustomApi([string]$unique, [string]$display, [string]$description, [string]$typeId, [array]$requests, [array]$responses) {
    $capi = (Invoke-Dv -Path "customapis?`$filter=uniquename eq '$unique'&`$select=customapiid").value | Select-Object -First 1
    if (-not $capi) {
        $capi = Invoke-Dv -Method POST -Path 'customapis' -Solution -Body @{
            uniquename = $unique; name = $unique; displayname = $display; description = $description
            bindingtype = 0; isfunction = $false; isprivate = $false; allowedcustomprocessingsteptype = 2
            executeprivilegename = "prvCreate$msgTable"; 'PluginTypeId@odata.bind' = "/plugintypes($typeId)"
        }
        Write-Host "+ custom API $unique"
    }
    foreach ($r in $requests) {
        $u = "${unique}_$($r.n)"
        if (-not (Invoke-Dv -Path "customapirequestparameters?`$filter=uniquename eq '$($r.n)' and _customapiid_value eq $($capi.customapiid)&`$select=customapirequestparameterid").value) {
            Invoke-Dv -Method POST -Path 'customapirequestparameters' -Solution -Body @{ uniquename = $r.n; name = $u; displayname = $r.n; description = $r.d; type = $r.t; isoptional = [bool]$r.o; 'CustomAPIId@odata.bind' = "/customapis($($capi.customapiid))" } | Out-Null
            Write-Host "  + in  $($r.n)"
        }
    }
    foreach ($r in $responses) {
        if (-not (Invoke-Dv -Path "customapiresponseproperties?`$filter=uniquename eq '$($r.n)' and _customapiid_value eq $($capi.customapiid)&`$select=customapiresponsepropertyid").value) {
            Invoke-Dv -Method POST -Path 'customapiresponseproperties' -Solution -Body @{ uniquename = $r.n; name = "${unique}_out_$($r.n)"; displayname = $r.n; description = $r.d; type = $r.t; 'CustomAPIId@odata.bind' = "/customapis($($capi.customapiid))" } | Out-Null
            Write-Host "  + out $($r.n)"
        }
    }
}
Ensure-CustomApi "${p}_SendWhatsAppMessage" 'Send WhatsApp message' 'Queues a WhatsApp template message. Creates a WhatsApp Message row (Queued/Scheduled) that triggers delivery.' $tSend @(
    @{ n = 'To'; t = 10; d = 'Recipient: E.164 phone number or WhatsApp user ID' }
    @{ n = 'Template'; t = 10; d = 'Template name or 019 template id' }
    @{ n = 'Variables'; t = 10; o = 1; d = 'JSON object of template variables, e.g. {"1":"Dana"}' }
    @{ n = 'Line'; t = 10; o = 1; d = 'Business line (default: environment variable WaDefaultLine)' }
    @{ n = 'ScheduledOn'; t = 1; o = 1; d = 'Send at this time (UTC). Empty = now' }
    @{ n = 'CampaignId'; t = 10; o = 1; d = 'Campaign or batch correlation' }
    @{ n = 'IdempotencyKey'; t = 10; o = 1; d = 'Returns the existing message when the key was already used' }
    @{ n = 'RelatedRecord'; t = 5; o = 1; d = 'Record that the message relates to (any table)' }
    @{ n = 'Source'; t = 10; o = 1; d = 'API, Flow, Agent, Bot or Campaign (default API)' }
    @{ n = 'CreateTimelineActivity'; t = 0; o = 1; d = 'Also create a timeline activity after sending' }
    @{ n = 'ConversationId'; t = 10; o = 1; d = 'Contact Center conversation to notify' }
) @(
    @{ n = 'MessageId'; t = 12; d = 'WhatsApp Message row id' }
    @{ n = 'Status'; t = 10; d = 'Queued, Scheduled or the existing status (idempotent)' }
)
Ensure-CustomApi "${p}_CancelWhatsAppMessage" 'Cancel WhatsApp message' 'Cancels a WhatsApp message that is still Queued or Scheduled.' $tCancel @(
    @{ n = 'MessageId'; t = 12; d = 'WhatsApp Message row id' }
) @(
    @{ n = 'Status'; t = 10; d = 'Resulting status' }
)

# ---------------------------------------------------------------- 4. async trigger steps
function Get-MessageFilter([string]$message) {
    $m = (Invoke-Dv -Path "sdkmessages?`$filter=name eq '$message'&`$select=sdkmessageid").value[0].sdkmessageid
    $f = (Invoke-Dv -Path "sdkmessagefilters?`$filter=_sdkmessageid_value eq $m and primaryobjecttypecode eq '$msgTable'&`$select=sdkmessagefilterid").value[0].sdkmessagefilterid
    @{ m = $m; f = $f }
}
function Ensure-Step([string]$message, [string]$filtering) {
    $name = "WhatsApp – enqueue on $message of $msgTable"
    $s = (Invoke-Dv -Path "sdkmessageprocessingsteps?`$filter=name eq '$name'&`$select=sdkmessageprocessingstepid").value | Select-Object -First 1
    if ($s) { return $s.sdkmessageprocessingstepid }
    $mf = Get-MessageFilter $message
    $body = @{
        name = $name; stage = 40; mode = 1; rank = 1; supporteddeployment = 0; asyncautodelete = $true
        'sdkmessageid@odata.bind' = "/sdkmessages($($mf.m))"; 'sdkmessagefilterid@odata.bind' = "/sdkmessagefilters($($mf.f))"
        'plugintypeid@odata.bind' = "/plugintypes($tEnqueue)"
    }
    if ($filtering) { $body.filteringattributes = $filtering }
    $s = Invoke-Dv -Method POST -Path 'sdkmessageprocessingsteps' -Solution -Body $body
    Write-Host "+ step $name"
    $s.sdkmessageprocessingstepid
}
Ensure-Step 'Create' $null | Out-Null
$upd = Ensure-Step 'Update' "${p}_messagestatus,${p}_scheduledon"
if (-not (Invoke-Dv -Path "sdkmessageprocessingstepimages?`$filter=_sdkmessageprocessingstepid_value eq $upd&`$select=sdkmessageprocessingstepimageid").value) {
    Invoke-Dv -Method POST -Path 'sdkmessageprocessingstepimages' -Solution -Body @{
        name = 'post'; entityalias = 'post'; imagetype = 1; messagepropertyname = 'Target'
        attributes = "${p}_messagestatus,${p}_scheduledon"; 'sdkmessageprocessingstepid@odata.bind' = "/sdkmessageprocessingsteps($upd)"
    } | Out-Null
    Write-Host "  + post image"
}

# ---------------------------------------------------------------- 5. plug-in identity (Entra app + FIC v2) + managedidentity record
$app = az ad app list --display-name $Cfg.pluginAppName --query "[0]" -o json | ConvertFrom-Json
if (-not $app) { $app = az ad app create --display-name $Cfg.pluginAppName --sign-in-audience AzureADMyOrg -o json | ConvertFrom-Json; Write-Host "+ app $($Cfg.pluginAppName)" }
$sp = az ad sp show --id $app.appId --query id -o tsv 2>$null
if (-not $sp) { $sp = az ad sp create --id $app.appId --query id -o tsv }

$tenantB64 = [Convert]::ToBase64String([Guid]::Parse($Cfg.tenantId).ToByteArray()).Replace('+', '-').Replace('/', '_').TrimEnd('=')
function Hash64Url([string]$s) { [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace('+', '-').Replace('/', '_').TrimEnd('=') }
$prefixSubject = "/eid1/c/pub/t/$tenantB64/a/qzXoWDkuqUa3l6zM5mM0Rw/n/plugin/e/$($Cfg.environmentId)"
$subjects = @{
    'plugin-dn-v2'   = "$prefixSubject/i/$(Hash64Url $cert.Issuer)/s/$(Hash64Url $cert.Subject)"
    'plugin-cert-v2' = "$prefixSubject/h/$(([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData) | ForEach-Object { $_.ToString('x2') }) -join '')"
}
$existingFic = az ad app federated-credential list --id $app.appId --query "[].subject" -o json | ConvertFrom-Json
foreach ($k in $subjects.Keys) {
    if ($existingFic -contains $subjects[$k]) { continue }
    $fic = @{ name = "$k-$(Get-Date -Format yyyyMMddHHmm)"; issuer = "https://login.microsoftonline.com/$($Cfg.tenantId)/v2.0"; subject = $subjects[$k]; audiences = @('api://AzureADTokenExchange') } | ConvertTo-Json -Compress
    $tmp = New-TemporaryFile; Set-Content $tmp $fic -Encoding ascii
    az ad app federated-credential create --id $app.appId --parameters "@$tmp" -o none; Remove-Item $tmp
    Write-Host "+ FIC $k"
}

$mi = (Invoke-Dv -Path "managedidentities?`$filter=applicationid eq $($app.appId)&`$select=managedidentityid").value | Select-Object -First 1
if (-not $mi) { $mi = Invoke-Dv -Method POST -Path 'managedidentities' -Solution -Body @{ applicationid = $app.appId; managedidentityid = [guid]::NewGuid().ToString(); credentialsource = 2; subjectscope = 1; tenantid = $Cfg.tenantId; version = 2 }; Write-Host "+ managedidentity record" }
Invoke-Dv -Method PATCH -Path "pluginassemblies($asmId)" -Body @{ 'managedidentityid@odata.bind' = "/managedidentities($($mi.managedidentityid))" } | Out-Null

# ---------------------------------------------------------------- 6. Service Bus Data Sender on the template queue
$q = az servicebus queue show -g $Cfg.azureResourceGroup --namespace-name $Cfg.serviceBusName -n $Cfg.templateQueue --query id -o tsv
az role assignment create --assignee-object-id $sp --assignee-principal-type ServicePrincipal --role 'Azure Service Bus Data Sender' --scope $q -o none 2>$null
Write-Host "= Service Bus Data Sender on $($Cfg.templateQueue)"

Write-Host "Done. Plug-in identity: $($app.appId)"
