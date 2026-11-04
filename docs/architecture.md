# Solution architecture

## 1. Solution concept

WhatsApp is delivered to Dynamics 365 Contact Center as a **first-class custom messaging channel**, built on the **Messaging API**.

A single serverless component, the **WhatsApp Adapter**, translates between two worlds:

| Side | Protocol | Direction |
|---|---|---|
| **019 WhatsApp API** | REST (Bearer token) + push webhooks (messages, delivery reports, system events) | Both ways |
| **Dynamics 365 Contact Center Messaging API** | REST (Entra OAuth) + webhook (Entra JWT) using the Bot Framework Activity schema | Both ways |

Everything else is **standard product configuration**: workstream, routing, queues, Copilot Studio agent, automated messages, masking and surveys. A small Dataverse solution adds the template catalog and the outbound activity.

### Design principles

1. **Native first.** Use Contact Center features for routing, the agent, the workspace and the transcript. The adapter only translates.
2. **Documented contracts only.** The adapter depends solely on the documented fields of the Messaging API and the 019 API.
3. **Author once in Copilot Studio.** Buttons and lists are authored with standard topics. Channel rendering is the adapter's job.
4. **Asynchronous by default.** Webhooks acknowledge immediately. Processing runs through Service Bus with per-conversation ordering.
5. **No shared secrets toward Microsoft.** Certificates and managed identity are used end to end.

## 2. Logical architecture

```mermaid
flowchart TB
    subgraph EXT[External]
      CUST([Customer WhatsApp])
      META[Meta WhatsApp Business Platform]
      O19[019 WhatsApp API]
      CUST <--> META <--> O19
    end

    subgraph AZURE[Azure – adapter landing zone]
      direction TB
      subgraph FUNC[Function App – WhatsApp Adapter]
        IN019[In019Incoming / In019Status<br/>HTTP]
        IND365[InD365Activity<br/>HTTP + JWT]
        API[ApiOutboundTemplate<br/>HTTP + JWT]
        PIN[ProcInbound<br/>SB session]
        POUT[ProcOutbound<br/>SB session]
        PST[ProcStatus<br/>SB]
        TPL[TplSync<br/>Timer]
      end
      SB[(Service Bus<br/>sb-inbound · sb-outbound · sb-status)]
      TBL[(Table Storage<br/>conversation · options · map · dedupe)]
      KV[(Key Vault)]
      AI[Application Insights]
    end

    subgraph D365[Dynamics 365 Contact Center]
      MAPI[Messaging API]
      HOOK[Webhook dispatcher]
      UR[Unified Routing]
      MCS[Copilot Studio agent]
      CSW[Copilot Service workspace]
      DV[(Dataverse)]
    end

    O19 -- push --> IN019 --> SB
    SB --> PIN -- create / message / event --> MAPI
    HOOK -- activities --> IND365 --> SB
    SB --> POUT -- send --> O19
    SB --> PST
    API --> O19
    TPL -- templates --> O19
    TPL -- upsert --> DV
    MAPI --> UR --> MCS
    UR --> CSW
    MCS -. replies .-> HOOK
    CSW -. replies .-> HOOK
    FUNC --> TBL
    FUNC --> KV
    FUNC --> AI
```

## 3. Components

| Component | Responsibility |
|---|---|
| `In019Incoming` | Receives 019 message pushes. Validates the route secret and line, de-duplicates, and enqueues to `sb-inbound` (session = line + WhatsApp user) |
| `In019Status` | Receives delivery reports (`hook: update`) and system events (`hook: system`), and enqueues to `sb-status` |
| `InD365Activity` | Webhook endpoint for Dynamics 365 (`/v3/conversations/{id}/activities`). Validates the Entra JWT and enqueues to `sb-outbound` (session = conversation) |
| `ProcInbound` | Creates or continues conversations through the Messaging API, maps message types, resolves button and list selections, handles opt-out |
| `ProcOutbound` | Renders agent and representative activities into WhatsApp text, buttons or lists. Handles typing, close events and the `/tpl` command |
| `ProcStatus` | Updates delivery status, sends read receipts, posts delivery notices to representatives, tracks template status |
| `ApiOutboundTemplate` | Entra-protected API for sending templates (flows, custom connector, custom page) |
| `TplSync` | Synchronizes 019 templates into the Dataverse template catalog every 15 minutes |

## 4. Key sequences

### 4.1 Inbound conversation with the agent

```mermaid
sequenceDiagram
    autonumber
    participant C as Customer (WhatsApp)
    participant O as 019
    participant A as Adapter
    participant D as D365 Messaging API
    participant B as Copilot Studio agent
    C->>O: "Hi"
    O->>A: POST /019/{secret}/incoming
    A-->>O: 200 (after enqueue)
    A->>D: POST /conversation/create (customer + context)
    D-->>A: conversationId
    A->>D: POST /conversation/{id} (message)
    D->>B: route to agent
    B-->>D: reply
    D->>A: POST /v3/conversations/{id}/activities (JWT)
    A->>O: send-whatsapp-message
    O->>C: reply
```

### 4.2 Interactive buttons and selection round-trip

```mermaid
sequenceDiagram
    autonumber
    participant B as Copilot Studio
    participant D as D365
    participant A as Adapter
    participant O as 019
    participant C as Customer
    B->>D: prompt + option block
    D->>A: activity (text with option block)
    A->>A: parse block, store pending options
    A->>O: send-buttons (≤3) / send-list (≤10)
    O->>C: native buttons
    C->>O: tap "Unlock user"
    O->>A: push type=button, body="Unlock user"
    opt WA_SELECTION_EVENT=true
        A->>D: event wa.selection → wa_LastInteraction (full JSON)
    end
    A->>D: message text="Unlock user" (+ value, channelData)
    D->>B: Question node matches → SelectedId = "unlock"
```

### 4.3 Outbound template and reply

```mermaid
sequenceDiagram
    autonumber
    participant F as Flow / Agent / Custom page
    participant A as Adapter API
    participant O as 019
    participant DV as Dataverse
    participant C as Customer
    participant D as D365
    F->>A: POST /outbound/template (Entra JWT)
    A->>O: send-whatsapp-template
    A->>DV: create WhatsApp Outbound activity (timeline)
    O->>C: template message
    O-->>A: DLR sent / delivered / read
    A->>DV: update delivery status
    C->>O: reply
    O->>A: incoming push
    A->>D: create conversation (entry = outbound-reply, startmessage = template)
    A->>DV: status = Replied, link conversation
```

## 5. Message mapping

| WhatsApp (019) | Dynamics 365 |
|---|---|
| `text` | `message.text` |
| `button`, `list` | `message.text` = original label + `value` / `channelData.wa.selection`. Optional selection event (`wa_LastInteraction`) |
| `location` | Text with a map link |
| `contacts` | Text with the contact name and number |
| `reaction` | Ignored |
| Media (`image`, `video`, `audio`, `ptt`, `document`) | Customer receives a "text only" response. Representative is notified |

| Dynamics 365 activity | WhatsApp (019) |
|---|---|
| Message (plain) | `send-whatsapp-message` (Markdown → WhatsApp formatting, 4,096-character split) |
| Message with option block, suggested actions, or Hero / Adaptive Card | `send-buttons` / `send-list` / numbered text |
| `typing` | `typing` |
| Close events | Conversation state closed |
| Representative `/tpl <name> v1\|v2` | `send-whatsapp-template` |

## 6. Conversation state

- **Per-conversation ordering:** Service Bus sessions (`{line}:{waUser}` inbound, `conversationId` outbound).
- **Idempotency:** a `Dedupe` table keyed by the 019 message id and the D365 activity id. `customerid` is supplied on `conversation/create`, so an active conversation is reused.
- **Conversation lifecycle:** close events from Dynamics 365 mark the conversation closed. The next customer message opens a new routed conversation.
- **24-hour window:** free-form messages are sent inside the WhatsApp customer-service window. Outside it, representatives send an approved template.
