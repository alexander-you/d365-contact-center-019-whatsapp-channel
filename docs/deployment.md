# Deployment guide

## Prerequisites

| Item | Notes |
|---|---|
| Azure subscription | Contributor + User Access Administrator on the target resource group |
| Microsoft Entra ID | Permission to create app registrations |
| Dynamics 365 Contact Center | Messaging enabled. System Administrator in the environment |
| Copilot Studio agent | Connected to Dynamics 365 Contact Center (handoff enabled) |
| 019 account | WhatsApp line verified in 019, plus an API token |
| Dataverse publisher | Customization prefix `alex`, option value prefix `62621`. Table and column names in the adapter use this prefix |
| Tools | Azure CLI, Bicep, Azure Functions Core Tools v4, Node.js 22, PowerShell 7, .NET SDK 8 (plug-in build) |
| Code-signing certificate | For the Dataverse plug-in (managed identity requires a signed assembly). A self-signed certificate is supported for development and test |

## 1. Azure infrastructure

```powershell
az group create -n rg-wa019-dev -l westeurope
copy infra/main.parameters.example.json infra/main.parameters.json   # set adminObjectId
az deployment group create -g rg-wa019-dev -f infra/main.bicep -p infra/main.parameters.json
```

This deploys the Function App (Flex Consumption, VNet integrated), Service Bus queues, Storage with tables, Key Vault, private endpoints with DNS, and Application Insights, with all RBAC assignments.

## 2. Entra app registration

1. Create a **single-tenant** app registration for the adapter.
2. **Expose an API:** Application ID URI `api://<appId>`.
3. **Manifest:** `requestedAccessTokenVersion = 2`.
4. Add a **certificate** credential.

## 3. Secrets

Key Vault is private. Write secrets through the ARM control plane with [`infra/kv-secrets.bicep`](../infra/kv-secrets.bicep):

| Secret | Value |
|---|---|
| `wa019-o19-api-token` | 019 API token |
| `wa019-webhook-path-secret` | Random string (≥ 32 characters, URL-safe) |
| `wa019-adapter-cert-pem` | Private key + certificate (PEM) |
| `wa019-adapter-cert-sha256` | Certificate SHA-256 thumbprint |

```powershell
az deployment group create -g rg-wa019-dev -f infra/kv-secrets.bicep `
  -p keyVaultName=<kv-name> secretsJson=@secrets.json
```

Pass `secretsJson` as a secure parameter, and delete `secrets.json` after deployment.

## 4. Adapter

### Option A (recommended): deploy the release package

Each [GitHub Release](../../../releases) contains a ready-to-deploy package built and tested by the `release` workflow: `adapter-<version>.zip` (compiled code and production dependencies), its SHA-256 checksum, and the compiled ARM templates.

```powershell
# Download adapter-<version>.zip and adapter-<version>.zip.sha256 from the release, then verify
(Get-FileHash .\adapter-<version>.zip -Algorithm SHA256).Hash.ToLower()   # compare with the .sha256 file

az functionapp config appsettings set -g rg-wa019-dev -n <function-app> --settings @appsettings.json
az functionapp deployment source config-zip -g rg-wa019-dev -n <function-app> --src .\adapter-<version>.zip
```

No build tools are needed on the deploying machine.

### Option B: build from source

```powershell
cd src/adapter
npm ci
npm test
az functionapp config appsettings set -g rg-wa019-dev -n <function-app> --settings @appsettings.json
func azure functionapp publish <function-app> --typescript
```

Use [`local.settings.example.json`](../src/adapter/local.settings.example.json) as the reference for app settings.

| Setting | Example |
|---|---|
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` | Tenant and adapter app ids |
| `ENTRA_ALLOWED_AUDIENCES` | `api://<appId>,<appId>` |
| `D365_MESSAGING_BASE_URL` | `https://m-<org-id>.<geo>.omnichannelengagementhub.com` |
| `D365_ORGANIZATION_ID` / `D365_CHANNEL_ID` | Organization id, custom channel id |
| `D365_TOKEN_SCOPE` | `https://<org-id-no-dashes>-c.<zone>.dynamics.com/.default` |
| `DATAVERSE_URL` | `https://<org>.crm.dynamics.com` |
| `O19_LINE_NUMBERS` | Comma-separated WhatsApp lines |
| `O19_SIMULATOR` | `false` in production. `true` records 019 calls for local testing |
| `WA_INBOUND_TYPING` | `true` (default): show "typing…" to the customer while the agent prepares an answer. Requires typing support on the 019 account |

## 5. Dynamics 365 Contact Center and Copilot Studio

```powershell
cd scripts
copy env.example.json env.json      # fill in organization, publisher, app, queue and bot values
./01-solution-and-tables.ps1        # solution, template catalog, outbound activity, opt-out column
./02-channel.ps1                    # app user, workstream, context variables, managed identity, channel, FIC
./03-copilot-studio.ps1             # global variables, topics, publish
./05-outbound-messages.ps1          # WhatsApp Message elastic table (outbound requests and lifecycle)
./06-plugin-and-custom-api.ps1 -CertificatePath .\codesign.pfx -CertificatePassword (Read-Host -AsSecureString)
                                    # plug-in, Custom APIs, async steps, plug-in managed identity, Service Bus role
                                    # (development/test: -DevCertificate)
./04-security-role.ps1              # adapter role + "WhatsApp Message Sender" role for callers
```

Run `04-security-role.ps1` after `05`, because the roles reference the WhatsApp Message table. Assign **WhatsApp Message Sender** to the users, flow connections and agents that send templates. See [Outbound messaging](outbound-messaging.md#8-deployment).

All scripts are idempotent. `02-channel.ps1` creates the **federated identity credential** from `GetComponentManagedIdentityFIC`. Re-run it after any change to the webhook configuration.

## 6. 019 webhooks

In the 019 portal (**Settings → URL assignment**), configure:

| Service | URL |
|---|---|
| `incoming_whatsapp` | `https://<function-app>.azurewebsites.net/api/019/<route-secret>/incoming` |
| `dlr_whatsapp` | `https://<function-app>.azurewebsites.net/api/019/<route-secret>/status` |

## 7. Verification

| Check | Expected |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `POST /api/outbound/templates/sync` (Entra JWT) | Template count from 019 (confirms the 019 credential) |
| Send "Hi" on WhatsApp | Conversation in the workstream, agent reply on WhatsApp |
| Send "menu" | Native WhatsApp buttons. A tap continues the topic with the right `SelectedId` |
| `/tpl` from a representative | Template list or a sent confirmation |
| `<prefix>_SendWhatsAppMessage` from Power Automate | Row *Queued* → *Sent* → *Delivered*; plug-in trace log shows *Enqueued* |
