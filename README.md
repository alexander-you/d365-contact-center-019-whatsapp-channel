# Dynamics 365 Contact Center – WhatsApp Custom Channel via 019

A production-grade **custom messaging channel** that connects **WhatsApp Business** (through the Israeli provider **019**) to **Microsoft Dynamics 365 Contact Center**. It uses the Contact Center **Messaging API**, **Copilot Studio** agents and **Azure** serverless components.

Customers chat on WhatsApp. Conversations are routed by **Unified Routing**, handled first by a **Copilot Studio** agent with native WhatsApp **reply buttons and lists**, and escalated to representatives in the **Copilot Service workspace**. Outbound **WhatsApp templates** are sent from Dynamics 365 and tracked on the timeline.

```mermaid
flowchart LR
    C([Customer<br/>WhatsApp]) <--> M[Meta<br/>WhatsApp Platform]
    M <--> O[019<br/>WhatsApp API]
    O -- "push: messages / DLR" --> A
    A -- "REST: text · buttons · list · template" --> O
    subgraph AZ[Azure subscription]
      A[WhatsApp Adapter<br/>Azure Functions]
      SB[(Service Bus<br/>sessions)]
      ST[(Table Storage)]
      KV[(Key Vault)]
      A <--> SB
      A <--> ST
      A --> KV
    end
    A -- "Messaging API · Entra OAuth" --> D
    D -- "Webhook · Entra JWT (managed identity)" --> A
    subgraph D365[Dynamics 365 Contact Center]
      D[Custom channel<br/>Messaging API]
      UR[Unified Routing]
      CS[Copilot Studio agent]
      WS[Copilot Service workspace]
      DV[(Dataverse)]
      D --> UR --> CS
      UR --> WS
      D --- DV
    end
```

## Highlights

| Capability | Description |
|---|---|
| **Native channel experience** | Messaging workstream, unified routing, queues, capacity, transcripts, automated messages, surveys and data masking, all standard Contact Center features |
| **Copilot Studio first** | The agent greets, answers and escalates. Escalation keeps the full context |
| **Interactive WhatsApp UI** | Reply buttons (up to 3) and lists (up to 10) rendered natively from Copilot Studio through a reusable topic, *WA · Ask with options* |
| **Selection round-trip** | Every tap returns to the agent as **text** (for matching) **and** as a **full JSON payload** (`wa_LastInteraction`) |
| **Templates and outbound** | Template catalog synced into Dataverse. Outbound from flows, a custom connector or the `/tpl` agent command. Replies are correlated back into routed conversations |
| **Delivery visibility** | Sent, delivered, read and failure states. Failures appear to the representative in the conversation |
| **Zero-secret D365 webhook** | Dynamics 365 calls the adapter with an Entra token issued through a **Power Platform managed identity** and **federated credential** |
| **Certificate-based auth** | The adapter authenticates to Dynamics 365 with an Entra app certificate stored in Key Vault |
| **Private data plane** | Key Vault and Storage are reachable only through **private endpoints**. The Function App uses **VNet integration** |
| **Ordered and idempotent** | Service Bus **sessions** give per-conversation FIFO. Every ingress is de-duplicated |

## Repository layout

```text
.
├── src/adapter/          Azure Functions (Node.js / TypeScript) – the WhatsApp Adapter
│   ├── src/functions/    HTTP endpoints, Service Bus processors, timer
│   ├── src/lib/          019 client, Messaging API client, mapping, templates, state, auth
│   └── test/             Unit tests (node:test)
├── infra/                Bicep – Azure landing zone for the adapter
├── scripts/              Dataverse / Contact Center provisioning (idempotent PowerShell)
├── copilot-studio/       Copilot Studio topics (YAML)
└── docs/                 Architecture, data model, security, deployment, operations
```

## Documentation

| Document | Content |
|---|---|
| [Solution architecture](docs/architecture.md) | Solution concept, components, end-to-end sequences |
| [Data model (ERD)](docs/data-model.md) | Dataverse tables, Contact Center entities, adapter state |
| [Azure components](docs/azure-components.md) | Resource inventory, networking, sizing |
| [Security](docs/security.md) | Identity, authentication flows, network, secrets, threat model |
| [Copilot Studio integration](docs/copilot-studio.md) | Option block contract, *WA · Ask with options*, selection payload |
| [Maker guide: interactive messages](docs/interactive-messages-maker-guide.md) | No-code recipes for quick replies, buttons, lists and link buttons |
| [Templates and outbound](docs/templates-and-outbound.md) | Catalog sync, outbound API, `/tpl`, reply correlation, opt-out |
| [Deployment guide](docs/deployment.md) | Step-by-step provisioning of Azure, Entra ID, Dataverse and Copilot Studio |
| [Operations](docs/operations.md) | Telemetry, alerts, runbooks |

## Quick start

```powershell
# 1. Azure infrastructure
az group create -n rg-wa019-dev -l westeurope
az deployment group create -g rg-wa019-dev -f infra/main.bicep -p infra/main.parameters.json

# 2. Adapter
cd src/adapter
npm ci
npm test
func azure functionapp publish <function-app-name> --typescript

# 3. Dynamics 365 Contact Center + Copilot Studio
cd ../../scripts
copy env.example.json env.json     # fill in your environment values
./01-solution-and-tables.ps1
./02-channel.ps1
./03-copilot-studio.ps1
./04-security-role.ps1
```

See the [deployment guide](docs/deployment.md) for prerequisites, secrets and the 019 webhook configuration.

## Technology

- **Dynamics 365 Contact Center:** Messaging API custom channel, Unified Routing, Copilot Service workspace
- **Microsoft Copilot Studio:** topics, global variables, Omnichannel context
- **Microsoft Dataverse:** template catalog, outbound activity, security role
- **Azure:** Functions (Flex Consumption, Node.js), Service Bus, Storage (Tables/Blobs), Key Vault, Application Insights, Virtual Network, Private Endpoints
- **Microsoft Entra ID:** app registration (certificate), federated identity credential, Power Platform managed identity
- **019:** WhatsApp Business API (messages, buttons, lists, templates, typing, delivery reports)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

## Trademarks

Microsoft, Dynamics 365, Copilot Studio, Dataverse, Azure and Microsoft Entra are trademarks of the Microsoft group of companies. WhatsApp is a trademark of Meta Platforms, Inc. 019 is a trademark of its respective owner. This project is not affiliated with, endorsed by or sponsored by Meta or 019.
