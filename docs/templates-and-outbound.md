# Templates and outbound messaging

## 1. Template catalog

WhatsApp templates are created and approved in the 019 portal. The adapter keeps a Dataverse catalog (`WhatsApp Template`) in sync:

- **Timer sync:** every 15 minutes, `get-phone-templates` → upsert by the 019 template id (alternate key).
- **Push sync:** template status events (approved, rejected, paused, banned, flagged, deleted) update the status immediately.
- **Admin columns are never overwritten:** *Usage* (Agent / Automation / Bot / Campaign), *Variable labels* and *Variable bindings*.

| 019 status | Dataverse status |
|---|---|
| 0 | Pending |
| 1, 11 | Approved |
| 2–5 | Rejected |
| 6 | Paused |
| 7 | Banned |
| 9 | Deleted |
| 10 | Flagged |

## 2. Outbound API

`POST /api/outbound/template` (Entra JWT)

```json
{
  "to": "9725XXXXXXXX",
  "templateName": "appointment_reminder",
  "variables": { "1": "Dana", "2": "12/11 10:00" },
  "context": {
    "campaignId": "APPOINTMENTS",
    "relatedEntity": "incident",
    "relatedRecordId": "00000000-0000-0000-0000-000000000000",
    "skipBot": true
  },
  "idempotencyKey": "case-123-reminder-1"
}
```

Processing:

1. **Idempotency:** a repeated `idempotencyKey` is rejected.
2. **Opt-out:** opted-out customers return `409 OPTED_OUT`.
3. **Template:** must be **Approved**. All `{{n}}` variables are required. Variables are sanitized (no new lines, no 4+ consecutive spaces). Body + variables must be ≤ 1,024 characters.
4. **Send:** `send-whatsapp-template`.
5. **Record:** a *WhatsApp Outbound* activity is created on the timeline of the regarding record. The 019 message id is mapped for delivery tracking.

| Response | Meaning |
|---|---|
| `200` | `{ status, o19Unique, renderedBody, outboundId }` |
| `400` | `MISSING_VARIABLE`, `TOO_LONG`, `BAD_TO` |
| `404` | `TEMPLATE_NOT_FOUND` |
| `409` | `OPTED_OUT`, `TEMPLATE_NOT_APPROVED`, `DUPLICATE` |
| `502` | 019 rejection (`O19_<reason>`) |

Use the API from:

- **Power Automate** (custom connector, OAuth 2.0 Entra ID) for event-based messages such as case created, case resolved or appointment reminders.
- A **custom page** (template picker) in the Copilot Service workspace.
- **Copilot Studio**, as a tool.
- **Customer Insights – Journeys**, through a custom channel.

## 3. Representative command

Inside an active conversation the representative can type:

```text
/tpl <template_name> value1|value2
```

The adapter intercepts the command, sends the template, and posts a confirmation to the conversation. It never forwards the command text to the customer. `/tpl` on its own lists the templates available to representatives.

## 4. Delivery tracking

| 019 event | Outbound activity status |
|---|---|
| `ack = 1` | Sent |
| `ack = 2` | Delivered |
| `ack = 3` | Read |
| `system / messages` (failure) | Failed (+ reason) |
| Customer reply | Replied (+ conversation id) |

Billing events (`isBilledTemplate`) set the *Billed Template* flag.

## 5. Reply correlation

When a customer replies within the configured window (default 72 hours) of an outbound template:

- `wa_EntryPoint` is set to `outbound-reply`, or to `template-button` when the customer tapped a template quick-reply.
- `wa_TemplateName`, `wa_CampaignId` and `wa_RelatedRecordId` are populated for routing rules.
- `startmessage` shows the representative the template that was sent.
- `skipdeflectionbot` follows the original request. Replies can go straight to a representative.

## 6. Consent

| Keyword (configurable) | Action |
|---|---|
| `STOP`, `הסר`, `הסרה` | Opt-out recorded, confirmation sent, representative notified |
| `START`, `הצטרף` | Opt-in restored |
