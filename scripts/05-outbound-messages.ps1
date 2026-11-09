# Outbound messaging – Elastic table for WhatsApp outbound messages (idempotent)
# Every proactive (template) send is a row. Creating a row with status Queued/Scheduled triggers delivery
# (async plug-in step -> Service Bus -> adapter). Rows expire automatically (TTL, default 365 days).
. (Join-Path $PSScriptRoot '_common.ps1')

$p = $Cfg.prefix
$t = "${p}_wamessage"
$ttlDays = if ($Cfg.messageRetentionDays) { [int]$Cfg.messageRetentionDays } else { 365 }

if (-not (Get-DvSingle "EntityDefinitions(LogicalName='$t')?`$select=LogicalName")) {
    # Payload mirrors what the Power Apps maker portal sends. The capabilities that elastic tables do not support
    # must be disabled explicitly; if any of them is left at its default, Dataverse silently creates a Standard table.
    $def = [ordered]@{
        SchemaName                    = $t
        Attributes                    = @( (New-StringAttr "${p}_name" 'Name' 300 -Primary) )
        HasNotes                      = $false
        HasActivities                 = $false
        DisplayName                   = New-Label 'WhatsApp Message'
        DisplayCollectionName         = New-Label 'WhatsApp Messages'
        PrimaryNameAttribute          = "${p}_name"
        OwnershipType                 = 'UserOwned'
        Description                   = New-Label 'Outbound WhatsApp message requests and delivery lifecycle (elastic). Creating a Queued/Scheduled row triggers delivery.'
        IsActivity                    = $false
        ActivityTypeMask              = 0
        IsAvailableOffline            = $false
        IsDuplicateDetectionEnabled   = @{ Value = $false }
        ChangeTrackingEnabled         = $false
        IsKnowledgeManagementEnabled  = $false
        EntityHelpUrlEnabled          = $false
        IsAuditEnabled                = @{ Value = $false }
        IsMailMergeEnabled            = @{ Value = $false }
        IsDocumentManagementEnabled   = $false
        IsOneNoteIntegrationEnabled   = $false
        IsConnectionsEnabled          = @{ Value = $false }
        IsActivityParty               = $false
        AutoCreateAccessTeams         = $false
        IsSolutionAware               = $false
        HasFeedback                   = $false
        IsQuickCreateEnabled          = $false
        IsOfflineInMobileClient       = @{ Value = $false }
        IsValidForQueue               = @{ Value = $false }
        IsSLAEnabled                  = $false
        SyncToExternalSearchIndex     = $false
        AutoRouteToOwnerQueue         = $false
        IsRetentionEnabled            = $false
        '@odata.type'                 = 'Microsoft.Dynamics.CRM.EntityMetadata'
        TableType                     = 'Elastic'
        CanCreateCharts               = @{ Value = $false }
    }
    Invoke-Dv -Method POST -Path 'EntityDefinitions' -Solution -Body $def | Out-Null
    $tt = (Invoke-Dv -Path "EntityDefinitions(LogicalName='$t')?`$select=TableType").TableType
    if ($tt -ne 'Elastic') {
        Write-Warning "Table $t was created as '$tt' although Elastic was requested. The solution works with both types (Standard: no partitioning, retention by bulk-delete job). To get Elastic, delete the table and create it in the maker portal (Type = Elastic), then rerun this script."
    }
    Write-Host "+ table $t ($tt)"
} else {
    $tt = (Invoke-Dv -Path "EntityDefinitions(LogicalName='$t')?`$select=TableType").TableType
    Write-Host "= table $t exists ($tt)"
}

Add-DvAttribute $t (New-StringAttr "${p}_to" 'To' 100)
Add-DvAttribute $t (New-StringAttr "${p}_linenumber" 'WhatsApp Line Number' 30)
Add-DvAttribute $t (New-StringAttr "${p}_template" 'Template (name or 019 id)' 512)
Add-DvAttribute $t (New-StringAttr "${p}_templateid" '019 Template Id' 200)
Add-DvAttribute $t (New-StringAttr "${p}_templatename" 'Template Name' 512)
Add-DvAttribute $t (New-MemoAttr "${p}_variables" 'Variables (JSON)' 4000)
Add-DvAttribute $t (New-MemoAttr "${p}_renderedbody" 'Rendered Body' 4000)
Add-DvAttribute $t (New-ChoiceAttr "${p}_messagestatus" 'Message Status' @('Queued', 'Scheduled', 'Sending', 'Sent', 'Delivered', 'Read', 'Replied', 'Failed', 'Canceled', 'Expired'))
Add-DvAttribute $t (New-ChoiceAttr "${p}_source" 'Source' @('API', 'Flow', 'Agent', 'Bot', 'Campaign'))
Add-DvAttribute $t @{ '@odata.type' = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'; SchemaName = "${p}_scheduledon"; DisplayName = New-Label 'Scheduled On'; RequiredLevel = @{ Value = 'None' }; Format = 'DateAndTime'; DateTimeBehavior = @{ Value = 'UserLocal' } }
Add-DvAttribute $t @{ '@odata.type' = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'; SchemaName = "${p}_senton"; DisplayName = New-Label 'Sent On'; RequiredLevel = @{ Value = 'None' }; Format = 'DateAndTime'; DateTimeBehavior = @{ Value = 'UserLocal' } }
Add-DvAttribute $t @{ '@odata.type' = 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata'; SchemaName = "${p}_repliedon"; DisplayName = New-Label 'Replied On'; RequiredLevel = @{ Value = 'None' }; Format = 'DateAndTime'; DateTimeBehavior = @{ Value = 'UserLocal' } }
Add-DvAttribute $t (New-StringAttr "${p}_campaignid" 'Campaign Id' 200)
Add-DvAttribute $t (New-StringAttr "${p}_idempotencykey" 'Idempotency Key' 200)
Add-DvAttribute $t (New-StringAttr "${p}_correlationid" 'Correlation Id' 200)
Add-DvAttribute $t (New-StringAttr "${p}_relatedentity" 'Related Table' 100)
Add-DvAttribute $t (New-StringAttr "${p}_relatedrecordid" 'Related Record Id' 100)
Add-DvAttribute $t (New-StringAttr "${p}_conversationid" 'Conversation Id' 100)
Add-DvAttribute $t (New-StringAttr "${p}_o19unique" '019 Message Id' 200)
Add-DvAttribute $t (New-IntAttr "${p}_attempts" 'Attempts')
Add-DvAttribute $t (New-StringAttr "${p}_failurecode" 'Failure Code' 50)
Add-DvAttribute $t (New-StringAttr "${p}_failurereason" 'Failure Reason' 500)
Add-DvAttribute $t (New-StringAttr "${p}_replybutton" 'Reply Button' 200)
Add-DvAttribute $t (New-IntAttr "${p}_replybuttonindex" 'Reply Button Index')
Add-DvAttribute $t (New-BoolAttr "${p}_createtimelineactivity" 'Create Timeline Activity')
Add-DvAttribute $t (New-StringAttr "${p}_activityid" 'Timeline Activity Id' 100)

Invoke-Dv -Method POST -Path 'PublishAllXml' -Body @{} | Out-Null
if ($tt -eq 'Elastic') { Write-Host "Published. Elastic: rows expire after $ttlDays days (ttlinseconds set by the Send API)." }
else { Write-Host "Published. Standard table: configure a bulk-delete job for rows older than $ttlDays days (see docs/outbound-messaging.md)." }
