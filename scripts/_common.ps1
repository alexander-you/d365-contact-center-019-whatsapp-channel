# Shared helpers for Dataverse Web API scripts (uses the signed-in Azure CLI identity)
$ErrorActionPreference = 'Stop'
if (-not $env:AZURE_EXTENSION_DIR) { $env:AZURE_EXTENSION_DIR = Join-Path $env:TEMP 'azext' }

$envFile = if ($env:WA019_ENV_FILE) { $env:WA019_ENV_FILE } else { Join-Path $PSScriptRoot 'env.json' }
if (-not (Test-Path $envFile)) { throw "Environment file not found: $envFile (copy env.example.json to env.json)" }
$script:Cfg = Get-Content $envFile -Raw | ConvertFrom-Json
$script:Org = $Cfg.orgUrl.TrimEnd('/')
$script:Api = "$Org/api/data/v9.2"

function Get-DvToken {
    if (-not $script:Tok -or (Get-Date) -gt $script:TokExp) {
        $t = az account get-access-token --resource $Org -o json | ConvertFrom-Json
        $script:Tok = $t.accessToken
        $script:TokExp = (Get-Date).AddMinutes(40)
    }
    $script:Tok
}

function Invoke-Dv {
    param([string]$Method = 'GET', [string]$Path, $Body, [hashtable]$Headers = @{}, [switch]$Solution)
    $h = @{
        Authorization      = "Bearer $(Get-DvToken)"
        Accept             = 'application/json'
        'OData-MaxVersion' = '4.0'
        'OData-Version'    = '4.0'
        Prefer             = 'return=representation'
    }
    if ($Solution) { $h['MSCRM.SolutionUniqueName'] = $Cfg.solutionUniqueName }
    foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
    $uri = if ($Path -match '^https?://') { $Path } else { "$Api/$Path" }
    $p = @{ Method = $Method; Uri = $uri; Headers = $h }
    if ($null -ne $Body) {
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress))
        $p.ContentType = 'application/json; charset=utf-8'
    }
    Invoke-RestMethod @p
}

function Get-DvSingle([string]$Path) {
    try { Invoke-Dv -Path $Path } catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { $null } else { throw } }
}

function New-Label([string]$text, [int]$lcid = 1033) {
    @{ '@odata.type' = 'Microsoft.Dynamics.CRM.Label'; LocalizedLabels = @(@{ '@odata.type' = 'Microsoft.Dynamics.CRM.LocalizedLabel'; Label = $text; LanguageCode = $lcid }) }
}

function New-StringAttr([string]$schema, [string]$label, [int]$max = 200, [switch]$Primary) {
    $a = @{
        '@odata.type'  = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
        SchemaName     = $schema
        DisplayName    = New-Label $label
        RequiredLevel  = @{ Value = 'None'; CanBeChanged = $true; ManagedPropertyLogicalName = 'canmodifyrequirementlevelsettings' }
        MaxLength      = $max
        FormatName     = @{ Value = 'Text' }
    }
    if ($Primary) { $a.IsPrimaryName = $true; $a.RequiredLevel.Value = 'ApplicationRequired' }
    $a
}

function New-MemoAttr([string]$schema, [string]$label, [int]$max = 4000) {
    @{ '@odata.type' = 'Microsoft.Dynamics.CRM.MemoAttributeMetadata'; SchemaName = $schema; DisplayName = New-Label $label
       RequiredLevel = @{ Value = 'None' }; MaxLength = $max; Format = 'TextArea' }
}

function New-IntAttr([string]$schema, [string]$label) {
    @{ '@odata.type' = 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata'; SchemaName = $schema; DisplayName = New-Label $label
       RequiredLevel = @{ Value = 'None' }; MinValue = 0; MaxValue = 100000; Format = 'None' }
}

function New-BoolAttr([string]$schema, [string]$label) {
    @{ '@odata.type' = 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata'; SchemaName = $schema; DisplayName = New-Label $label
       RequiredLevel = @{ Value = 'None' }; DefaultValue = $false
       OptionSet = @{ TrueOption = @{ Value = 1; Label = New-Label 'Yes' }; FalseOption = @{ Value = 0; Label = New-Label 'No' } } }
}

function New-ChoiceAttr([string]$schema, [string]$label, [string[]]$options, [switch]$Multi) {
    $i = 0
    $opts = foreach ($o in $options) { @{ Value = [int]$Cfg.optionPrefix * 10000 + $i++; Label = New-Label $o } }
    @{
        '@odata.type' = if ($Multi) { 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata' } else { 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata' }
        SchemaName    = $schema; DisplayName = New-Label $label; RequiredLevel = @{ Value = 'None' }
        OptionSet     = @{ '@odata.type' = 'Microsoft.Dynamics.CRM.OptionSetMetadata'; IsGlobal = $false; OptionSetType = 'Picklist'; Options = @($opts) }
    }
}

function Add-DvAttribute([string]$entity, $attr) {
    $logical = $attr.SchemaName.ToLower()
    if (Get-DvSingle "EntityDefinitions(LogicalName='$entity')/Attributes(LogicalName='$logical')?`$select=LogicalName") {
        Write-Host "  = $logical exists"; return
    }
    Invoke-Dv -Method POST -Path "EntityDefinitions(LogicalName='$entity')/Attributes" -Body $attr -Solution | Out-Null
    Write-Host "  + $logical"
}
