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
