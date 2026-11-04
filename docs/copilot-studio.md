# Copilot Studio integration

## 1. Overview

The Copilot Studio agent is attached to the **WhatsApp 019** workstream like any other Contact Center channel. It:

- greets and answers;
- presents **native WhatsApp buttons and lists**;
- reads WhatsApp context through global variables;
- escalates to representatives with full context.

## 2. Option block (agent → adapter contract)

Buttons and lists are carried in the activity `text` as a reserved, machine-readable block. The adapter strips the block before anything is sent to WhatsApp.

```text
<prompt shown to the customer>
⟦wa|<mode>|<header>|<footer>⟧
⟦opt|<id>|<label>|<description>⟧
⟦opt|<id>|<label>|<description>⟧
⟦url|<label>|https://…⟧
```

| Element | Rules |
|---|---|
| `⟦wa\|mode\|header\|footer⟧` | `mode` is `auto` (≤3 → buttons, 4–10 → list, >10 → numbered text), `buttons`, `list` or `text`. `header` is the list header text, or `img:https://…` for an image header on buttons |
| `⟦opt\|id\|label\|desc⟧` | `id` is a stable machine value. `label` is ≤20 characters for buttons and ≤24 for list rows. `desc` is the list row description (≤72). Up to 10 options |
| `⟦url\|label\|url⟧` | Rendered as an external button when it is the only action. Otherwise it is appended as a link |

The adapter also renders Copilot Studio **quick replies (suggested actions)**, **basic (Hero) cards** and **Adaptive Cards** (`Action.Submit`, `Input.ChoiceSet`, `Action.OpenUrl`), which is the same subset Microsoft documents for WhatsApp agents. As a compatibility fallback, options written as the last paragraph of a message and separated by `" / "` are also rendered as buttons or a list.

For a no-code, step-by-step guide for makers, see [interactive-messages-maker-guide.md](./interactive-messages-maker-guide.md).

## 3. Reusable topic: *WA · Ask with options*

Makers call this topic with **Redirect** instead of authoring channel-specific nodes.

| Input | Example |
|---|---|
| `Prompt` | `How can I help?` |
| `Labels` | `Unlock user\|Check block\|Agent` |
| `Ids` | `unlock\|check\|agent` |
| `Mode` | `auto` |
| `Header` / `Footer` | `` / `Contoso IT` |

| Output | Example |
|---|---|
| `SelectedId` | `unlock` |
| `SelectedLabel` | `Unlock user` |
| `SelectionPayload` | Full JSON selection payload (`Global.wa_LastInteraction`) |

Example topic call:

```yaml
- kind: BeginDialog
  id: callAsk
  dialog: <bot_schema>.topic.WAAskWithOptions
  input:
    binding:
      Prompt: How can I help?
      Labels: Unlock user|Check block|Agent
      Ids: unlock|check|agent
      Footer: Contoso IT
  output:
    binding:
      SelectedId: Topic.ChoiceId
      SelectedLabel: Topic.ChoiceLabel
      SelectionPayload: Topic.ChoicePayload
```

How the topic works:

1. It builds the option block in Power Fx.
2. It asks a **Question** that accepts the label, the option number, or a typed answer.
3. It resolves the stable `id` and reprompts once on invalid input.

## 4. Selection round-trip

When the customer taps a button or list row, the adapter sends **two ordered activities** to the conversation:

1. **Custom event `wa.selection`** that updates the context variable `wa_LastInteraction` with the full JSON:

   ```json
   {
     "promptId": "…",
     "id": "unlock",
     "label": "Unlock user",
     "index": 1,
     "method": "tap",
     "kind": "buttons",
     "source": "block",
     "options": [ { "id": "unlock", "label": "Unlock user" } ],
     "o19": { "…": "raw 019 push" },
     "receivedUtc": "…"
   }
   ```

2. **Message** with `text` = the original label, plus `value` and `channelData.wa.selection`. The Question node matches natively.

Number replies (`1`, `2`, …) and typed labels are resolved the same way. Taps on older prompts are forwarded as plain text.

## 5. Global variables

| Variable | Set by |
|---|---|
| `wa_LastInteraction` | Selection event |
| `wa_UserId`, `wa_ProfileName`, `wa_LineNumber`, `wa_EntryPoint`, `wa_TemplateName` | Conversation context at creation |

Each variable is created as a **global** variable with *External sources can set values* enabled. Its name matches the workstream context variable exactly.

## 6. Deployment

`scripts/03-copilot-studio.ps1` creates the global variables and the topics (`WA · Variables`, `WA · Ask with options`, `WA · Demo menu`), then publishes the agent and reports the publish status.
