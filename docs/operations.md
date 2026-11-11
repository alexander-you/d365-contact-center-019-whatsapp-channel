# Operations

## 1. Telemetry

The adapter emits structured events to Application Insights. Events carry ids, types and status codes, and **never message content**.

| Event | Emitted when |
|---|---|
| `O19Push` | 019 message push received |
| `ConversationCreated` | Messaging API conversation created (`entry`: organic / outbound-reply / template-button) |
| `InboundReceived` | Customer message posted to Dynamics 365 |
| `TypingSent` | "typing…" indicator sent to the customer on an incoming message (`WA_INBOUND_TYPING`) |
| `D365Activity` | Activity received from the Dynamics 365 webhook |
| `OptionRendered` | Buttons, list or numbered options sent (`kind`, `count`, `source`) |
| `OptionMatched` | Selection resolved (`method`: tap / number / typed) |
| `O19Call` | 019 API call result (`api`, `http`, `reason`) |
| `O19System` | 019 system event (delivery failure, template, account) |
| `MessageQueued` | REST or `/tpl` request accepted (WhatsApp Message row created) |
| `MessageSent` / `MessageFailed` | Outbound template sent to 019, or failed (`code`) |
| `MessageSkipped` / `MessageNotDue` | Queue item ignored: row canceled or already processed / scheduled time not reached |
| `TemplateSync` | Template catalog sync |
| `WindowClosed` | Send attempted outside the 24-hour window |
| `ConversationClosed` | Close event from Dynamics 365 |

Example query:

```kusto
traces
| where timestamp > ago(1h)
| where message startswith "{"
| extend e = parse_json(message)
| summarize count() by tostring(e.evt), bin(timestamp, 5m)
```

## 2. Recommended alerts

| Alert | Condition |
|---|---|
| Messaging API authentication | Any 401 from the Messaging API in 5 minutes |
| Webhook probing | More than 10 rejected JWT or route-secret calls in 5 minutes |
| 019 account event | `O19System` with `type = issues` (Severity 1) |
| Delivery failures | Failure rate above 5% in 15 minutes |
| Dead-letter queue | Any message in a DLQ (including `sb-template`) |
| Outbound failures | *WhatsApp Message* rows with status *Failed* above your threshold (Power Automate or a Dataverse view) |
| Credential expiry | Certificate or 019 token expiring within 30 days |
| Inbound silence | No `O19Push` for N minutes during business hours |

## 3. Runbooks

| Runbook | Steps |
|---|---|
| **Rotate the 019 token** | Create a token in 019 → write it with `kv-secrets.bicep` → wait 5 minutes (cache) → delete the old token |
| **Rotate the certificate** | Create a certificate → add it to the app registration → write the PEM and SHA-256 to Key Vault → remove the old credential |
| **Webhook URL change** | Update the channel record → re-run `02-channel.ps1` (refreshes the FIC) |
| **Rotate the route secret** | Write a new secret → update both 019 push URLs |
| **Add a WhatsApp line** | Verify the line in 019 → append it to `O19_LINE_NUMBERS` |
| **Replay the DLQ** | Inspect with Service Bus Explorer → resubmit after fixing the root cause |
| **Requeue an outbound message** | Set *Message Status* back to *Queued* on the WhatsApp Message row (the update step enqueues it again) |
| **Rotate the plug-in signing certificate** | Sign with the new certificate and rerun `06-plugin-and-custom-api.ps1 -CertificatePath …` (adds the matching federated credential), then remove the old credential from the plug-in app |
| **Outbound stuck in *Queued*** | Check the plug-in trace log (`EnqueueMessage`) and Application Insights exceptions for `ProcTemplate`. See [troubleshooting](outbound-messaging.md#10-troubleshooting) |
| **New environment** | `main.bicep` → app registration → secrets → adapter → scripts 01–03, 05, 06, 04 → 019 URLs |

## 4. Health endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | Anonymous | Liveness |
| `POST /api/outbound/templates/sync` | Entra JWT | On-demand template catalog sync |

## Representative notices

The adapter posts automated `[WhatsApp]` notices to the representative (delivery failures, closed 24-hour window, files that couldn't be sent, opt-out, hidden phone number).

- Notices are in **Hebrew** and say what happened and what to do. 019 error codes are mapped in `O19_REASON_HE` (send errors) and `O19_FAILURE_HE` (delivery failures).
- **De-duplication:** the same notice (conversation + error code) is shown at most once per `WA_NOTICE_DEDUPE_MINUTES` (default 5). Repeats are counted, and the next notice shows `(חזר N פעמים)`. State is kept in the `Notices` table.
