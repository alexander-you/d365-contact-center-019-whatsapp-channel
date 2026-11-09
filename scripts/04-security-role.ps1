# Phase 4 – Minimal security role for the adapter application user (idempotent)
. (Join-Path $PSScriptRoot '_common.ps1')

$roleName = 'WhatsApp 019 Adapter'
$out = Get-Content (Join-Path $PSScriptRoot 'out.channel.json') -Raw | ConvertFrom-Json
$rootBu = (Invoke-Dv -Path "businessunits?`$filter=parentbusinessunitid eq null&`$select=businessunitid").value[0].businessunitid

$role = (Invoke-Dv -Path "roles?`$filter=name eq '$roleName' and _businessunitid_value eq $rootBu&`$select=roleid").value | Select-Object -First 1
if (-not $role) {
    $role = Invoke-Dv -Method POST -Path 'roles' -Solution -Body @{ name = $roleName; 'businessunitid@odata.bind' = "/businessunits($rootBu)" }
    Write-Host "+ role $($role.roleid)"
} else { Write-Host "= role $($role.roleid)" }

# Privileges: org-level CRUD on template catalog + outbound activity; read contact/incident/account (regarding + bindings)
$names = @()
foreach ($op in 'Create', 'Read', 'Write', 'Append', 'AppendTo') { $names += "prv${op}alex_watemplate"; $names += "prv${op}Activity" }  # custom activities use the shared Activity privileges
foreach ($e in 'contact', 'incident', 'account') { $names += "prvRead$e"; $names += "prvAppendTo$e" }
$names += 'prvReadmsdyn_occustommessagingchannel'   # honour the channel's "File attachments" settings
foreach ($op in 'Create', 'Read', 'Write', 'Append', 'AppendTo') { $names += "prv${op}$($Cfg.prefix)_wamessage" }  # outbound message lifecycle
$names += 'prvReadAsyncOperation'   # status updates trigger the async enqueue step (system job owned by the caller)

$privs = foreach ($n in $names) {
    $p = (Invoke-Dv -Path "privileges?`$filter=name eq '$n'&`$select=privilegeid,name").value | Select-Object -First 1
    if ($p) { @{ PrivilegeId = $p.privilegeid; Depth = 'Global'; BusinessUnitId = $rootBu } } else { Write-Warning "privilege $n not found" }
}
Invoke-Dv -Method POST -Path "roles($($role.roleid))/Microsoft.Dynamics.CRM.AddPrivilegesRole" -Body @{ Privileges = @($privs) } | Out-Null
Write-Host "  privileges: $($privs.Count)"

# Assign to the adapter application user
$assigned = (Invoke-Dv -Path "systemusers($($out.appUserId))/systemuserroles_association?`$select=roleid&`$filter=roleid eq $($role.roleid)").value
if (-not $assigned) {
    Invoke-Dv -Method POST -Path "systemusers($($out.appUserId))/systemuserroles_association/`$ref" -Body @{ '@odata.id' = "$Api/roles($($role.roleid))" } | Out-Null
    Write-Host "+ assigned to app user"
} else { Write-Host "= already assigned" }

# Role for callers of the Send/Cancel Custom APIs (users, Power Automate connections, Copilot Studio agents)
$senderName = 'WhatsApp Message Sender'
$sender = (Invoke-Dv -Path "roles?`$filter=name eq '$senderName' and _businessunitid_value eq $rootBu&`$select=roleid").value | Select-Object -First 1
if (-not $sender) { $sender = Invoke-Dv -Method POST -Path 'roles' -Solution -Body @{ name = $senderName; 'businessunitid@odata.bind' = "/businessunits($rootBu)" }; Write-Host "+ role $senderName" }
$sp = $Cfg.prefix
$senderPrivs = foreach ($n in @("prvCreate${sp}_wamessage", "prvRead${sp}_wamessage", "prvWrite${sp}_wamessage", "prvRead${sp}_watemplate", 'prvReadAsyncOperation')) {
    $pv = (Invoke-Dv -Path "privileges?`$filter=name eq '$n'&`$select=privilegeid").value | Select-Object -First 1
    if ($pv) { @{ PrivilegeId = $pv.privilegeid; Depth = if ($n -like 'prvRead*') { 'Global' } else { 'Basic' }; BusinessUnitId = $rootBu } }
}
Invoke-Dv -Method POST -Path "roles($($sender.roleid))/Microsoft.Dynamics.CRM.AddPrivilegesRole" -Body @{ Privileges = @($senderPrivs) } | Out-Null
Write-Host "  sender privileges: $(@($senderPrivs).Count) (assign this role to users or flow connections that send messages)"
