# Templates and outbound messaging

## 1. Template catalog

WhatsApp templates are created and approved in the 019 portal. The adapter keeps a Dataverse catalog (`WhatsApp Template`) in sync:

- **Timer sync:** every 15 minutes, `get-phone-templates` → upsert by the 019 template id (alternate key).
- **Push sync:** template status events (approved, rejected, paused, banned, flagged, deleted) update the status immediately. The **category** (utility, marketing, authentication) is set from these events only, because `get-phone-templates` doesn't return it.
- **Language:** 019 returns numeric language codes. `1` is stored as `he`; unknown codes are stored as received.
- **Admin columns are never overwritten:** *Usage* (Agent / Automation / Bot / Campaign), *Variable labels* and *Variable bindings*.
- **Templates created through 019 only:** `get-phone-templates` lists the templates managed in 019. Templates created directly in Meta WhatsApp Manager don't appear until they're added in 019.
- **Admin access:** the catalog appears in the Copilot Service admin center under *Customer support*, below *Customer settings*. Add the `WhatsApp Template` table to the admin app's site map to expose it in your environment.

| 019 status | Dataverse status |
|---|---|
| 0 | Pending |
| 1, 11 | Approved |
| 2–5 | Rejected |
| 6 | Paused |
| 7 | Banned |
| 9 | Deleted |
| 10 | Flagged |

## 2. Sending templates

Proactive messages are rows in the **WhatsApp Message** elastic table, created through the **`<prefix>_SendWhatsAppMessage`** Custom API. Delivery is asynchronous (plug-in → Service Bus → adapter → 019). The full design, API reference and how-to for Power Automate, Copilot Studio and the custom connector are in **[Outbound messaging](outbound-messaging.md)**.

The adapter REST API remains available for existing integrations and calls the same Custom API:

`POST /api/outbound/template` (Entra JWT)

```json
{
  "to": "14255550100",
  "templateName": "appointment_reminder",
  "variables": { "1": "Dana", "2": "12/11 10:00" },
  "scheduledOn": "2026-12-01T08:00:00Z",
  "createTimelineActivity": true,
  "context": {
    "campaignId": "APPOINTMENTS",
    "relatedEntity": "incident",
    "relatedRecordId": "00000000-0000-0000-0000-000000000000"
  },
  "idempotencyKey": "case-123-reminder-1"
}
```

| Response | Meaning |
|---|---|
| `202` | `{ messageId, status }` – the WhatsApp Message row (`Queued` or `Scheduled`) |
| `400` | `BAD_REQUEST`, or `REJECTED` with the validation message (unknown or unapproved template, missing variable, invalid recipient) |
| `401` | Missing or invalid token |

Opt-out and 019 rejections are recorded on the row as *Failed* with a failure code.
## 3. Representative command

Inside an active conversation the representative can type:

```text
/tpl <template_name> value1|value2
```

The adapter intercepts the command, queues the template through the Custom API (with a timeline activity), and posts a confirmation to the conversation when it is sent. It never forwards the command text to the customer. `/tpl` on its own lists the templates available to representatives.

## 4. Delivery tracking

Delivery reports update the **WhatsApp Message** row (and the timeline activity, when one was created):

| 019 event | Message status |
|---|---|
| Accepted by 019 | Sent |
| `ack = 2` | Delivered |
| `ack = 3` | Read |
| `system / messages` (failure) | Failed (+ reason) |
| Customer reply or button tap | Replied (+ conversation id, button) |

## 5. Reply correlation

Template button taps are matched **exactly** to the message that was sent (019 returns the original message ID). Free-text replies use the most recent message to the customer within the configured window (default 72 hours). See [Outbound messaging – template buttons](outbound-messaging.md#6-template-buttons-and-reply-correlation) for the context variables (`wa_EntryPoint`, `wa_TemplateName`, `wa_OutboundMessageId`, `wa_TemplateButton`, `wa_TemplateButtonIndex`, `wa_CampaignId`, `wa_RelatedEntity`, `wa_RelatedRecordId`).
## 6. Consent

| Keyword (configurable) | Action |
|---|---|
| `STOP`, `הסר`, `הסרה` | Opt-out recorded, confirmation sent, representative notified |
| `START`, `הצטרף` | Opt-in restored |
