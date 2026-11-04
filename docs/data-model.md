# Data model

The solution uses three data stores:

1. **Dataverse:** a custom solution with two tables, plus standard Contact Center tables.
2. **Contact Center configuration:** the channel, workstream, context variables and managed identity records.
3. **Adapter state:** Azure Table Storage holding operational keys only. It stores no message bodies.

## 1. Dataverse and Contact Center (ERD)

```mermaid
erDiagram
    CONTACT ||--o{ WA_OUTBOUND_MESSAGE : "regarding"
    INCIDENT ||--o{ WA_OUTBOUND_MESSAGE : "regarding"
    WA_TEMPLATE ||--o{ WA_OUTBOUND_MESSAGE : "templateId"
    WA_OUTBOUND_MESSAGE }o--o| OC_LIVEWORKITEM : "conversationId (on reply)"

    LIVEWORKSTREAM ||--o{ WORKSTREAM_CONTEXT_VARIABLE : "defines"
    LIVEWORKSTREAM ||--|| CUSTOM_MESSAGING_CHANNEL : "bound to"
    CUSTOM_MESSAGING_CHANNEL }o--|| MANAGED_IDENTITY : "webhook auth"
    LIVEWORKSTREAM }o--|| QUEUE : "default queue"
    LIVEWORKSTREAM }o--|| SYSTEMUSER_BOT : "Copilot Studio agent"
    CUSTOM_MESSAGING_CHANNEL ||--o{ OC_LIVEWORKITEM : "channel"
    OC_LIVEWORKITEM }o--o| CONTACT : "customer"

    WA_TEMPLATE {
        guid    watemplateid PK
        string  name
        string  templateid "AK – 019 template id"
        string  linenumber
        string  language
        memo    body
        int     variablecount
        string  headertype
        string  buttons
        string  quickreplies
        string  ctawebsiteurl
        choice  category "Utility | Marketing | Authentication"
        choice  status "Approved | Pending | Rejected | Paused | Banned | Flagged | Deleted"
        multichoice usage "Agent | Automation | Bot | Campaign"
        memo    variablelabels "JSON"
        memo    variablebindings "JSON"
    }

    WA_OUTBOUND_MESSAGE {
        guid    activityid PK
        string  subject
        lookup  regardingobjectid
        string  to
        string  linenumber
        string  templateid
        memo    variables "JSON"
        memo    renderedbody
        choice  deliverystatus "Queued | Sent | Delivered | Read | Failed | Replied"
        string  o19unique
        string  failurereason
        string  campaign
        bool    billed
        string  conversationid
    }

    CONTACT {
        guid    contactid PK
        string  telephone1
        bool    whatsappoptout
    }

    CUSTOM_MESSAGING_CHANNEL {
        guid    occustommessagingchannelid PK
        choice  occustomchannelid "Messaging API"
        string  appid
        string  tenantid
        string  webhookurl
        lookup  managedidentityid
        lookup  liveworkstreamid
    }

    MANAGED_IDENTITY {
        guid    managedidentityid PK
        string  applicationid
        string  tenantid
        int     credentialsource
        int     subjectscope
    }

    LIVEWORKSTREAM {
        guid    liveworkstreamid PK
        string  name "WhatsApp 019"
        choice  streamsource "Custom"
        int     autocloseafterinactivity
    }

    WORKSTREAM_CONTEXT_VARIABLE {
        guid    id PK
        string  name "wa_*"
        choice  datatype
        bool    isdisplayable
    }

    OC_LIVEWORKITEM {
        guid    ocliveworkitemid PK
        lookup  customer
        lookup  channelreferenceid
    }

    QUEUE {
        guid    queueid PK
    }

    SYSTEMUSER_BOT {
        guid    systemuserid PK
        guid    applicationid
    }

    INCIDENT {
        guid    incidentid PK
        string  ticketnumber
    }
```

`WA_TEMPLATE`, `WA_OUTBOUND_MESSAGE` and the `whatsappoptout` column are delivered by the solution. The remaining entities are standard Dynamics 365 Contact Center tables.

## 2. Workstream context variables

| Name | Type | Shown to representative | Content |
|---|---|---|---|
| `wa_LineNumber` | Text | No | WhatsApp business line |
| `wa_UserId` | Text | No | WhatsApp user identifier (phone, or a WhatsApp-scoped id) |
| `wa_ProfileName` | Text | Yes | WhatsApp profile name |
| `wa_EntryPoint` | Text | Yes | `organic` · `outbound-reply` · `template-button` |
| `wa_TemplateName` | Text | Yes | Template that triggered the conversation |
| `wa_CampaignId` | Text | No | Outbound correlation |
| `wa_RelatedRecordId` | Text | No | Record that triggered the outbound message |
| `wa_Is24hWindowOpen` | Boolean | No | Informational |
| `wa_LastInteraction` | Text (JSON) | No | Full payload of the latest button or list selection (only when `WA_SELECTION_EVENT=true`) |

Copilot Studio receives each variable as a **global variable with the same name**, with *External sources can set values* enabled.

## 3. Adapter state (Azure Table Storage)

```mermaid
erDiagram
    CONVERSATIONS ||--|| CONVINDEX : "conversationId"
    CONVERSATIONS ||--o| PENDINGOPTIONS : "latest prompt"
    CONVERSATIONS ||--o{ MSGMAP : "sent messages"
    OUTBOUNDLOG }o--|| CONVERSATIONS : "reply correlation"

    CONVERSATIONS {
        string PartitionKey "line"
        string RowKey "waUserId"
        string conversationId
        string state "Active | Closed"
        string lastInboundUtc
        string phone
        string profileName
    }
    CONVINDEX {
        string PartitionKey "conv"
        string RowKey "conversationId"
        string line
        string waUserId
    }
    PENDINGOPTIONS {
        string PartitionKey "conversationId"
        string RowKey "latest"
        string json "promptId, kind, options(id,label,sent)"
    }
    MSGMAP {
        string PartitionKey "conversationId"
        string RowKey "019 unique"
        string sentUtc
        string kind
        string dvId
    }
    OUTBOUNDLOG {
        string PartitionKey "line"
        string RowKey "waUserId:reverseTicks"
        string templateName
        string renderedBody
        string campaignId
        string relatedRecordId
        bool   skipBot
        string sentUtc
        bool   replied
    }
    DEDUPE {
        string PartitionKey "source"
        string RowKey "id"
    }
    OPTOUT {
        string PartitionKey "line"
        string RowKey "waUserId"
        string optedOutUtc
    }
```

**Data minimization:** message bodies are never written to tables. They exist only transiently in Service Bus (TTL of 1 day) and in Dynamics 365.
