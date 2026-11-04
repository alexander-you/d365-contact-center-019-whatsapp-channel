# Phase 0 – Solution, tables and columns (idempotent)
. (Join-Path $PSScriptRoot '_common.ps1')

# --- Solution
$sol = (Invoke-Dv -Path "solutions?`$filter=uniquename eq '$($Cfg.solutionUniqueName)'&`$select=solutionid").value | Select-Object -First 1
if (-not $sol) {
    $sol = Invoke-Dv -Method POST -Path 'solutions' -Body @{
        uniquename = $Cfg.solutionUniqueName; friendlyname = $Cfg.solutionDisplayName; version = '1.0.0.0'
        description = 'WhatsApp via 019 – Dynamics 365 Contact Center custom messaging channel (Messaging API)'
        'publisherid@odata.bind' = "/publishers($($Cfg.publisherId))"
    }
    Write-Host "+ solution $($Cfg.solutionUniqueName)"
} else { Write-Host "= solution exists" }

function Ensure-Entity([string]$schema, [hashtable]$def) {
    $logical = $schema.ToLower()
    if (Get-DvSingle "EntityDefinitions(LogicalName='$logical')?`$select=LogicalName") { Write-Host "= table $logical exists"; return }
    Invoke-Dv -Method POST -Path 'EntityDefinitions' -Body $def -Solution | Out-Null
    Write-Host "+ table $logical"
}

# --- Template catalog
Ensure-Entity 'alex_watemplate' @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata'
    SchemaName = 'alex_watemplate'; DisplayName = New-Label 'WhatsApp Template'; DisplayCollectionName = New-Label 'WhatsApp Templates'
    Description = New-Label 'WhatsApp templates synced from 019'
    OwnershipType = 'OrganizationOwned'; HasActivities = $false; HasNotes = $false; IsActivity = $false
    PrimaryNameAttribute = 'alex_name'
    Attributes = @( (New-StringAttr 'alex_name' 'Template Name' 512 -Primary) )
}
$t = 'alex_watemplate'
Add-DvAttribute $t (New-StringAttr 'alex_templateid' '019 Template Id' 200)
Add-DvAttribute $t (New-StringAttr 'alex_linenumber' 'WhatsApp Line Number' 30)
Add-DvAttribute $t (New-StringAttr 'alex_language' 'Language' 20)
Add-DvAttribute $t (New-MemoAttr 'alex_body' 'Body' 4000)
Add-DvAttribute $t (New-IntAttr 'alex_variablecount' 'Variable Count')
Add-DvAttribute $t (New-StringAttr 'alex_headertype' 'Header Type' 20)
Add-DvAttribute $t (New-StringAttr 'alex_buttons' 'Buttons Type' 20)
Add-DvAttribute $t (New-StringAttr 'alex_quickreplies' 'Quick Replies' 400)
Add-DvAttribute $t (New-StringAttr 'alex_ctawebsiteurl' 'CTA Website URL' 1000)
Add-DvAttribute $t (New-ChoiceAttr 'alex_category' 'Category' @('Utility', 'Marketing', 'Authentication'))
Add-DvAttribute $t (New-ChoiceAttr 'alex_status' 'Template Status' @('Approved', 'Pending', 'Rejected', 'Paused', 'Banned', 'Flagged', 'Deleted'))
Add-DvAttribute $t (New-ChoiceAttr 'alex_usage' 'Usage' @('Agent', 'Automation', 'Bot', 'Campaign') -Multi)
Add-DvAttribute $t (New-MemoAttr 'alex_variablelabels' 'Variable Labels (JSON)' 2000)
Add-DvAttribute $t (New-MemoAttr 'alex_variablebindings' 'Variable Bindings (JSON)' 2000)

# Alternate key on 019 template id
if (-not (Invoke-Dv -Path "EntityDefinitions(LogicalName='$t')/Keys?`$select=LogicalName").value) {
    Start-Sleep 5
    Invoke-Dv -Method POST -Path "EntityDefinitions(LogicalName='$t')/Keys" -Solution -Body @{
        SchemaName = 'alex_templateid_key'; DisplayName = New-Label '019 Template Id'; KeyAttributes = @('alex_templateid')
    } | Out-Null
    Write-Host "  + key alex_templateid_key"
}

# --- Outbound message (activity -> appears in timeline)
Ensure-Entity 'alex_waoutboundmessage' @{
    '@odata.type' = 'Microsoft.Dynamics.CRM.EntityMetadata'
    SchemaName = 'alex_waoutboundmessage'; DisplayName = New-Label 'WhatsApp Outbound'; DisplayCollectionName = New-Label 'WhatsApp Outbound Messages'
    Description = New-Label 'Outbound WhatsApp template sent via 019'
    OwnershipType = 'UserOwned'; IsActivity = $true; HasActivities = $false; HasNotes = $true
    IsAvailableOffline = $true
    PrimaryNameAttribute = 'subject'
    Attributes = @( (New-StringAttr 'Subject' 'Subject' 200 -Primary) )
}
$o = 'alex_waoutboundmessage'
Add-DvAttribute $o (New-StringAttr 'alex_to' 'WhatsApp To' 100)
Add-DvAttribute $o (New-StringAttr 'alex_linenumber' 'WhatsApp Line Number' 30)
Add-DvAttribute $o (New-StringAttr 'alex_templateid' '019 Template Id' 200)
Add-DvAttribute $o (New-MemoAttr 'alex_variables' 'Variables (JSON)' 2000)
Add-DvAttribute $o (New-MemoAttr 'alex_renderedbody' 'Rendered Body' 4000)
Add-DvAttribute $o (New-ChoiceAttr 'alex_deliverystatus' 'Delivery Status' @('Queued', 'Sent', 'Delivered', 'Read', 'Failed', 'Replied'))
Add-DvAttribute $o (New-StringAttr 'alex_o19unique' '019 Message Id' 200)
Add-DvAttribute $o (New-StringAttr 'alex_failurereason' 'Failure Reason' 500)
Add-DvAttribute $o (New-StringAttr 'alex_campaign' 'Campaign' 200)
Add-DvAttribute $o (New-BoolAttr 'alex_billed' 'Billed Template')
Add-DvAttribute $o (New-StringAttr 'alex_conversationid' 'Conversation Id' 100)

# --- Opt-out flag on contact
Add-DvAttribute 'contact' (New-BoolAttr 'alex_whatsappoptout' 'WhatsApp Opt-out')

Invoke-Dv -Method POST -Path 'PublishAllXml' -Body @{} | Out-Null
Write-Host "Published."
