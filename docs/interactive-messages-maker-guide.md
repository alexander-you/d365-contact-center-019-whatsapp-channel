# Maker guide: WhatsApp quick replies, buttons and lists from Copilot Studio

This guide shows Copilot Studio makers how to produce native WhatsApp interactive messages through this channel without writing code. The adapter converts standard Copilot Studio constructs automatically.

## 1. Cheat sheet

| What you want in WhatsApp | What to build in Copilot Studio | Result |
|---|---|---|
| Quick reply buttons (Yes / No) | **Question** node → *Identify*: **Multiple choice options** with 2–3 options | Reply buttons |
| Menu with 4–10 options | **Question** node → **Multiple choice options** with 4–10 options | List message with an *Options* button |
| Quick replies after a message | **Message** node → **+ Add** → **Quick replies** | Reply buttons (≤3) or list (4–10) |
| A single link button | **Message** node → **+ Add** → **Basic card** with one *Open URL* button | Call-to-action URL button |
| Stable IDs, header/footer, forced list | Redirect to the reusable topic **WA · Ask with options** | Full control (see [copilot-studio.md](./copilot-studio.md)) |

Rendering rules applied by the adapter:

| Number of options | WhatsApp element | Label limit |
|---|---|---|
| 1–3 | Reply buttons | 20 characters |
| 4–10 | List | 24 characters (row description up to 72) |
| More than 10 | Numbered text (customer replies with the number or the text) | — |

Longer labels are truncated with "…" and duplicates are made unique. The agent always receives the **full** original label.

## 2. Recipe: Yes / No buttons

1. **Topics** → **+ Add a topic** → **From blank**. Name: `Confirm restart`.
2. Trigger: add phrases, or a description if the agent uses generative orchestration.
3. **+** → **Ask a question**:
   - Message: `Did you restart the computer?`
   - **Identify**: **Multiple choice options**
   - **Options for user**: `Yes`, `No`
   - Save the response as `Var1`.
4. Under each option branch, add the next step, for example a **Message** node: `Great, let's continue`.
5. **Save** → **Publish**.

In WhatsApp, the customer sees the question with two reply buttons. A tap returns `Yes` or `No` to the agent, and the matching branch runs.

## 3. Recipe: Menu as a WhatsApp list

Same as section 2, with 4–10 options:

- Message: `How can I help?`
- Options: `Password reset`, `Remote access`, `Printer`, `Network issue`, `Shared mailbox`, `Agent`

The customer gets the message with an **Options** button. Tapping it opens the list, and the selected row is returned as text.

## 4. Recipe: Link button

1. **+** → **Send a message** → **+ Add** → **Basic card**.
2. Set the title or text, and add **one** button of type **Open URL**.

If the card has other buttons in addition to the URL, the link is appended to the message text instead.

## 5. Do and don't

| ✅ Do | ❌ Don't |
|---|---|
| Use a **Question** node with **Multiple choice options** for every choice | Type the options inside the message text (`1. … 2. …`), which arrives as plain text |
| Keep labels short and unique (≤20 for buttons, ≤24 for lists) | Use long sentences as options |
| Branch on the option value (`Var1`) | Rely on the exact truncated label shown in WhatsApp |
| Keep ≤10 options per question; split larger menus into two levels | Put 15 options in one question |
| Test from a real phone after **Publish** | Assume the test canvas looks the same as WhatsApp |

> **Compatibility fallback**: if a legacy topic writes its options as the last paragraph of the message, separated by `" / "` (for example `Yes / No`), the adapter still converts them to buttons or a list. Numbered text (`1. … 2. …`) is not converted. New topics should use a Question node.

## 6. Verify

Each bot message is logged in Application Insights as `D365Activity` with the number of structured options. Successful rendering is logged as `OptionRendered`.

```kusto
traces
| where timestamp > ago(30m)
| where message has_any ("D365Activity", "OptionRendered", "OptionMatched")
| project timestamp, message
| order by timestamp asc
```

| You see | Meaning | Fix |
|---|---|---|
| `suggestedActions: 3` + `OptionRendered kind=buttons` | Working | — |
| `suggestedActions: 0`, `hasBlock: false` | The topic sends plain text | Rebuild the step as a Question node with multiple choice options |
| `OptionMatched method=tap` | The tap was matched to the pending question | — |
| Tap arrives but no `OptionMatched` | Customer tapped an older message | Expected. The label is forwarded as plain text |
