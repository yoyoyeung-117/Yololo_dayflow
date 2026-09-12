# Dayflow

Dayflow detects a likely delay, asks for your approval on **Telegram**, sends individual proposals to coworkers on **WhatsApp through Twilio**, and reports their replies back to you.

**Open the app:** http://localhost:4317 → **Connections**.

The open-weight model **Qwen3 4B** runs locally through Ollama. No Microsoft/Entra account or paid LLM API key is needed.

## Continue from here

1. Create a [Twilio account](https://console.twilio.com/) and activate its WhatsApp testing environment.
2. In Dayflow → Connections, enter the Twilio Account SID, Auth Token, test sender number, and optional sandbox join code. Click **Save & verify Twilio**.
3. Add your demo coworkers’ names and international phone numbers; click **Save coworkers**.
4. Click **Start reply connection**. Copy the generated incoming webhook URL to Twilio’s **When a message comes in** field, select **POST**, and save in Twilio.
5. Have every coworker join your Twilio sandbox and then send **hello** to the test number. Wait for Dayflow to show **Ready · hello received** next to each coworker.
6. Pair your Telegram bot if you have not already done so.
7. Select **WhatsApp live**, click **Advance to 1:15 pm**, and approve the proposal on Telegram. Each coworker gets a separate WhatsApp message from the Twilio test number.
8. Ask coworkers to quote/reply to their proposal, or type its current reference, for example `#DF-ABC123 yes`. Dayflow records responses and sends you the result on Telegram.

**Calendar, location and travel inputs are scenario replay data in both modes.** “WhatsApp live” enables real delivery and real replies. This demo does not track a locked phone or change calendar invitations.

## Twilio WhatsApp setup

### Account and testing environment

In the legacy Twilio Console, open **Messaging → Try it out → Send a WhatsApp message**, then activate the **Sandbox**. In the newer trial Console, look for **Try out WhatsApp**. The legacy Sandbox supports multiple joined recipients, which is useful for the coworker demo.

The Twilio testing screen shows a test sender number and a join instruction such as `join example-code`. The legacy Sandbox commonly uses `+14155238886`; use the actual sender shown in your console.

Find the **Account SID** (starts with `AC`) and **Auth Token** in the account dashboard. Enter these in Dayflow’s local Connections panel. The Auth Token is a secret: do not paste it into chat or commit it to Git. Clicking **Save & verify Twilio** only checks the account; it does not send a coworker message.

No WhatsApp Business Account registration is needed for the legacy Sandbox. Twilio trial restrictions and messaging charges can apply. If your account restricts recipient numbers, follow the console’s verification instructions or use a permitted test participant.

### Coworkers and the messaging window

Add up to five coworkers, each with a different number in E.164 format, e.g. `+85212345678` (illustrative only). Names and phone numbers appear on your approval card.

Each coworker must:

1. Send the Sandbox’s `join ...` message to the test number, or follow the testing environment’s connect-device instructions.
2. After the webhook URL is configured, send **hello** as a separate message to that same number.

A message from a coworker opens WhatsApp’s 24-hour window for free-form responses. Dayflow waits until it has received a signed inbound message from every configured coworker before allowing a live proposal. It uses a five-minute buffer at the end of that window. Ask coworkers to send hello again before a later demo. Sandbox membership expires after three days and may need renewal.

If you enter the optional join code in Dayflow, Connections provides a link that opens the join message in WhatsApp. You can share that link with your demo participants yourself.

This implementation sends separate one-to-one messages from the Twilio test sender. It does not connect to your personal WhatsApp account or an existing WhatsApp group.

### Incoming replies and the temporary connection

Dayflow runs two separate local HTTP listeners:

| Listener | Address | Purpose |
| --- | --- | --- |
| Dashboard | `http://localhost:4317` | UI, settings and your approval controls |
| Webhooks | `http://127.0.0.1:4319` | Only signed incoming WhatsApp messages and delivery callbacks |

The **Start reply connection** button runs `cloudflared` against **port 4319 only**. The public URL has this shape:

```text
https://your-temporary-host.trycloudflare.com/webhooks/whatsapp/incoming
```

Paste the exact URL shown in Dayflow into Twilio’s **When a message comes in** field, choose **POST**, and save. Twilio’s configuration may call this **Sandbox settings** or **Sandbox configuration**.

The outgoing API request automatically sets the delivery-status callback URL, so a second Twilio console field is not required.

Keep Dayflow running throughout the demo. Restarting its temporary connection produces a new URL: copy the new URL into Twilio and save again. On application restart, click **Start reply connection** again. Dayflow does not automatically change your Twilio console configuration.

Only the webhook listener is reachable through this tunnel. It validates Twilio signatures against the exact configured public URL, account and sender. It exposes no settings, approval routes, or frontend. Received messages are saved locally before acknowledgment, then interpreted asynchronously so model loading does not delay Twilio’s response.

For a stable tunnel you already manage, forward it to port 4319 and enter its HTTPS base URL under **Use an existing public webhook connection**. Save the settings and configure the corresponding incoming URL in Twilio. Do not forward the dashboard port.

## Telegram setup

Existing Telegram pairing survives the WhatsApp replacement.

If you have not paired it yet:

1. Open the verified **@BotFather** in Telegram and send `/newbot`.
2. Choose a bot display name and username ending in `bot`.
3. Paste its token into Dayflow → Connections → Telegram.
4. Click **Save & pair Telegram**, open the pairing link on your phone and tap **Start**. Alternatively, send the exact `/start CODE` shown by Dayflow to your bot.

Only the paired private account can approve proposals. The card shows the proposal and recipients, plus **Approve & send to WhatsApp**, alternative-time buttons, and **Dismiss**. Choosing another time prepares a new proposal and requires a fresh approval.

Telegram uses long polling, so it needs no webhook or public tunnel. Use a dedicated bot; Dayflow will not replace an existing bot webhook.

## Start and edit the project

Dependencies and local tools have been installed on this computer. Requirements on another computer: Node.js 22.12+ or 24, npm, Ollama, and cloudflared for live incoming WhatsApp replies.

```bash
cd /Users/yeungyingyau/Developer/dayflow
npm install
npm run build
npm run launch
```

The launcher starts the local model server if needed, starts Dayflow, and opens the browser on macOS. Keep the terminal open; press Ctrl+C to stop. Click **Start reply connection** in Connections when you want live WhatsApp replies.

If the tools are missing on macOS:

```bash
brew install ollama cloudflared
ollama serve
```

In a separate terminal:

```bash
ollama pull qwen3:4b
```

For development, stop the existing Dayflow server and run:

```bash
npm run dev
# Open http://localhost:5173
```

After editing, `npm run build` refreshes the production frontend. `npm start` starts the backend with the built frontend, without opening a browser.

## Rehearse without sending real messages

1. Leave **Simulated WhatsApp** selected.
2. Click **Advance to 1:15 pm**. Actual lateness rules evaluate replayed samples spanning 15 minutes.
3. Approve the replay proposal on the dashboard or Telegram.
4. Use **The conversation** to submit Alex’s “Yes”. It should say **1/2 agreed**.
5. Submit Sam’s “Could we do 2:15 pm instead?”. The model should record the counterproposal and request your attention.
6. Prepare 2:15, approve it, and have both simulated coworkers accept.

The final status says everyone agreed while explicitly noting that the calendar invite has not changed.

## Delivery and reply behavior

- Each recipient gets a separate message, spaced at least three seconds apart for the Sandbox’s sending limit.
- The provider accepting a request means **Queued by Twilio**, not delivered or accepted by a coworker. Signed status callbacks update sent/delivered/read/failed separately.
- Every proposal has a new reference. A coworker’s direct quote or exact current reference correlates their reply. Unrelated messages, unknown phone numbers, old references and duplicate webhook deliveries do not count.
- “Read” does not mean agreement. Silence remains waiting. An explicit ambiguous reply needs clarification.
- If one send fails or times out, successful recipient receipts are preserved and remaining messages are not attempted. No automatic resend occurs. Check each delivery status and the Twilio Messaging logs before proposing again.
- Failed/unknown delivery and a coworker’s explicit reply are different events. A correlated reply can establish that an uncertain message actually reached the recipient.
- Approvals expire after ten minutes. Double taps and old Telegram buttons cannot send twice. Changing recipients invalidates the previously prepared approval.
- **Finish monitoring** does not cancel meetings or retract messages.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Twilio credentials cannot be verified | Use the Account SID and Auth Token from the same account; confirm the account is active. |
| Waiting for hello | Save the incoming URL with POST in Twilio; have the coworker join, then send hello separately. Check their exact international number in Dayflow. |
| Reply connection stopped | Start it again and replace the webhook URL in Twilio. |
| Error 63015 | Coworker has not joined this Sandbox, or membership expired. |
| Error 63016 | Messaging window closed; ask the coworker to send hello again. |
| Error 63007 | Check the WhatsApp sender number against the Twilio testing screen. |
| Error 21608 | Follow Twilio’s trial recipient verification requirements. |
| Message queued but not received | Check Twilio Messaging logs and Dayflow delivery status; do not assume it was delivered. |
| Reply not interpreted | Quote the actual proposal or include its current `#DF-...` reference. A plain “yes” without context is deliberately ignored. |
| Model unavailable | Run Ollama, download the configured model, and click Save & check model. The labelled rules-only replay remains available. |

## Code map

```text
src/App.tsx                  Dashboard, Connections and demo controls
src/styles.css               Visual tokens and responsive layout
shared/types.ts              Proposals, recipients, delivery and integration types
server/app.ts                Private local API and service orchestration
server/engine.ts             Delay detection, approval and recipient state transitions
server/whatsapp.ts           Twilio API, messaging windows and reply correlation
server/webhooks.ts           Separate signed ingress and persistent reply queue
server/tunnel.ts             Temporary webhook-only Cloudflare connection
server/telegram.ts           Bot pairing, owner callbacks and phone notifications
server/llm.ts                Ollama, structured interpretation and evidence checks
server/store.ts              Local settings and state persistence
scripts/launch.mjs           Start local services and open the browser
```

Old proposals from the previous transport are archived to `.local/state-before-whatsapp.json` if present. Telegram pairing and model settings are retained. The old Microsoft adapter and dependency have been removed.

## Local data and verification

Configuration and received replies are written to `.local` with owner-only permissions. `.local` and `.env` are ignored by Git. Both the Twilio Auth Token and Telegram token are omitted from frontend API responses. Saved Connections settings override environment defaults in `.env.example`.

This remains a single-operator local demo. The temporary public service accepts authenticated Twilio callbacks only; it is not a public multi-user app. The bounded inbox and replay cache suit the demo, not a high-volume deployment.

```bash
npm run build
npm test
npm run test:e2e
npm run test:llm
```

Browser tests use isolated dashboard/webhook ports 4318 and 4320 and produce screenshots under `test-results`. On another machine, run `npx playwright install chromium` once. API and webhook tests use fake credentials, signed synthetic requests and mocked provider sends; they never send real WhatsApp or Telegram messages. Live exchange still requires your account setup and a manual rehearsal.

## References

- [Twilio WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)
- [Twilio messaging API](https://www.twilio.com/docs/messaging/api/message-resource)
- [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [WhatsApp inbound reply context](https://www.twilio.com/en-us/changelog/whatsapp-inbound-messages-will-now-include-reply-context)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Ollama chat API](https://docs.ollama.com/api/chat)
