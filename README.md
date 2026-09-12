# Dayflow

Dayflow spots a likely delay, asks for your approval privately on **Telegram**, sends meeting proposals through **Discord and Zoom Team Chat**, collects replies, and reports back to you.

**Open the app: http://localhost:4317 → My calendar.**

Your existing Telegram owner pairing and Ollama settings are retained. WhatsApp and Twilio have been removed. The open-weight model **Qwen3 4B** runs locally through Ollama.

## The platform roles

| Platform | Who communicates | Purpose |
| --- | --- | --- |
| Telegram | You ↔ Dayflow | Private suggestions, approval buttons, progress and results |
| Discord | You and coworkers, with Dayflow coordinating | Proposals and coworker replies in the selected team channel |
| Zoom Team Chat | You and coworkers, with Dayflow coordinating | Proposals and replies in existing contact conversations |

Coworkers do not join the Telegram bot. Participant destinations are restricted to Discord and Zoom in both the interface and API.

## Continue from here

1. In **Connections → Telegram**, check your saved owner connection. This is your private channel with the agent.
2. Connect **Discord** or **Zoom Team Chat** using the instructions below. You can use either or both.
3. Under **Your meeting participants**, add coworkers with a Discord user ID or Zoom contact email. Choose **Include in meeting** for the people to contact, then **Save coworkers**.
4. Select **Live messages**, advance the lunch scenario, and review the proposed time and recipients on Telegram.
5. Tap **Approve & send to coworkers**. Dayflow sends the approved request through Discord/Zoom.
6. Coworkers reply there using a direct reply or the current `#DF-…` reference. Dayflow records their answers and reports back to you privately on Telegram.

If you have not paired the owner yet, use the verified **@BotFather** in Telegram, send `/newbot`, and paste its token into Connections. Click **Save & pair Telegram** and open the private owner pairing link. Only you use this pairing link. Use a dedicated bot without an existing webhook or another polling process.

## Add Discord

Discord delivery uses a bot in one regular server text channel. It mentions each selected coworker in a separate message. **All members with access to that channel can see these proposals.**

1. Open [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On **Bot**, copy/reset the **bot token**. Enable **Message Content Intent** so Dayflow can read normal replies.
3. Under **Installation**, select **Guild Install**, add the `bot` scope, and grant **View Channels**, **Send Messages**, and **Read Message History**. Install the bot into a server you manage.
4. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your dedicated text channel and choose **Copy Channel ID**.
5. In Dayflow **Connections → Discord**, enter the token and channel ID; click **Save & connect Discord**. This checks bot identity and channel history access without sending a message.
6. Add a coworker with platform **Discord**. Right-click that person in Discord, copy their **User ID**, paste it into their row, and save.
7. After your approval, they receive a mention in that channel. They should reply directly to their proposal, or include the current reference, for example `#DF-ABC123 yes`.

The bot polls this channel approximately every six seconds while monitoring a live proposal. No public webhook or Discord Gateway connection is required. Use a quiet demo channel. Server permission overrides can still prevent sending; any error appears on that recipient instead of being reported as success.

## Add Zoom Team Chat

Zoom delivery sends from **your authorized Zoom account** to existing **Team Chat contacts**. It does not join a video call, send in-meeting chat, or create/reschedule Zoom meetings.

### Configure the app

1. Open [Zoom App Marketplace](https://marketplace.zoom.us/develop/create) and create a **General App** using **user-managed OAuth**. Use your app’s development credentials and local-test/distribution settings.
2. Add these **user-level** granular scopes:
   - `user:read:user` — verify the authorized account.
   - `team_chat:write:user_message` — send a Team Chat message.
   - `team_chat:read:list_user_messages` — collect contact replies.
3. Enter the **Client ID** and **Client Secret** in Dayflow **Connections → Zoom** and click **Save Zoom settings**.
4. Click **Start Zoom authorization connection**. Dayflow starts cloudflared on its isolated OAuth callback listener, port **4319**.
5. Copy the exact **Zoom OAuth Redirect URL** shown in Dayflow, ending in `/oauth/zoom/callback`. Save it as the app’s OAuth Redirect URL and in its OAuth allow list in Zoom.
6. Back in Dayflow, click **Create Zoom authorization link**, then **Authorize on Zoom**. Sign in with the Zoom account that will send proposals and accept the requested access. Return to Dayflow when the connection succeeds.
7. Add a coworker with platform **Zoom Team Chat** and their existing contact email, then **Save coworkers** and **Check Zoom connection**.

Your organization may require approval to install an app. If you cannot authorize the app or access Team Chat APIs, leave Zoom participants unchecked and continue with Discord and your Telegram owner connection. An unused Zoom connection does not block Discord participants.

The temporary URL is needed for OAuth authorization only. If it changes before you reconnect, update it in Zoom and create a fresh authorization link. Refresh tokens are saved locally and renewed server-side. API replies are polled about every six seconds; an inbound-message webhook is not needed.

An existing HTTPS connection may be used instead: forward it to **4319**, enter the base URL in the Zoom panel, save, and register the exact generated callback URL in Zoom. Never forward the dashboard port.

## One meeting, several platforms

Each participant has one selected platform and an **Include in meeting** checkbox. For example:

| Participant | Platform | Delivery |
| --- | --- | --- |
| Sam | Discord | Mention in the selected channel |
| Jamie | Zoom Team Chat | Direct message from your Zoom account |

Only checked participants receive requests. Connect all the platforms used by those participants, review the combined recipient list, and approve once. There is no automatic fallback to another platform and no unsolicited test send.

## What is real and what is simulated

- **Simulated messages:** seeded coworkers, no real coworker messages. If your owner Telegram account is paired, it may receive explicitly labelled replay approval cards and updates.
- **Live messages:** real platform delivery and authenticated replies, after owner approval.
- **Practice scenario:** lunch, calendar entries, location samples and travel estimates are seeded data; it never edits Calendar. Meeting times use **Hong Kong time (HKT)**.
- **My calendar:** reads actual events from Apple Calendar on this Mac and uses its current timezone. Complete, approved plans can update editable personal events after all selected friends accept. Calendar invitations stay fixed. There is no locked-phone location tracking.
- Qwen drafts the opening and interprets replies; deterministic guards require affirmative evidence and actual mentioned times. When unavailable, conservative rules handle explicit yes/no and leave uncertain text for review.
- A counterproposal requires a fresh owner approval. The current demo does not automatically discover everybody’s calendar availability.

## Apple Calendar on Mac and iPhone

1. Open **My calendar → Connect Apple Calendar** and allow **Full Access** for **Dayflow Calendar** if macOS asks. No Apple password or Microsoft registration is needed. If denied, enable it in System Settings → Privacy & Security → Calendars.
2. Enable iCloud Calendar on your Mac and iPhone using the same Apple Account. Dayflow reads calendars already available on the Mac. Only iCloud-backed events sync to iPhone; “On My Mac” events stay local.
3. Add your Discord friends in **Connections**, with each person's Discord user ID. On the calendar timeline, mark future personal events **Allow this event to move later**, then select the friends for that event. No selected friends means personal time and no social messages. Invitations, all-day events and read-only calendars stay fixed.
4. Turn on **Check in on Telegram when an event ends**. Keep this Mac awake and Dayflow running. A Telegram check-in asks whether you're finished or need another 15/30 minutes. Monitoring starts when enabled; it does not send retrospective check-ins for earlier events.
5. Or select a current/recently ended event on the dashboard, enter remaining extra minutes and a travel/transition buffer, then **Review the rest of my day**. The planner preserves durations, uses available gaps and shifts flexible appointments around fixed ones. Conflicts with fixed commitments or moves past midnight block approval.
6. Review **every before/after time, friend and exact message**. Approve the full plan on Telegram or on the Mac. Real calendar plans always use real Discord/Zoom messages after approval; the practice scenario's simulation switch does not apply.
7. Each affected meeting has a separate reference and reply inbox. All named friends must explicitly accept before any calendar save. A decline, unclear reply or counterproposal pauses the plan. Review replies, stop that plan and build a fresh one with new approval. No silent acceptance or automatic negotiation of unapproved times.
8. Dayflow rereads the day before sending and before saving; intervening Calendar changes invalidate the plan. One batch updates only the selected event occurrences. The current overrun event's stored end time is not extended. The Mac reports confirmed saves privately on Telegram.

**Five-minute rehearsal with real events:** in Apple Calendar, add a personal “Lunch demo” ending in one minute and a “Coffee demo” starting in about 15 minutes. Put Coffee in an editable iCloud calendar, without Apple invitees. Refresh Dayflow, mark Coffee flexible, and select your Discord friend. Enable check-ins, wait for Lunch to end, and tap **Need 30 more min** on Telegram. Review and approve the resulting message; your friend replies with its `#DF-… yes` reference. Verify Coffee moves in Calendar and syncs to iPhone. Delete your demo events afterward in Calendar. No rehearsal events are created automatically.

An existing active practice conversation must be finished before a Calendar plan can send. **Stop this plan** stops monitoring but does not retract already sent messages. Approvals expire after ten minutes; coordination stops after thirty minutes or when a proposed time passes. Restart during coordination pauses for review. A restart or error during Calendar saving is treated as uncertain: inspect Calendar before trying again; the app never retries writes automatically.

The schedule planner is deterministic. The local open model interprets friend replies with the existing evidence checks; it cannot select recipients or authorize calendar writes. All-day entries are displayed but excluded from timed travel calculations. Dayflow cannot read your friends' private calendars, estimate live traffic or detect an actual overrun from Calendar alone.

## Reliability and approval behavior

- Only the paired owner can use Telegram approval buttons. Telegram messages and old coworker buttons cannot register participants or count as coworker replies.
- Approval expires after ten minutes. Replaced approval cards and double taps cannot send twice.
- The sender, channel and participant addresses are checked again at approval. Configuration is locked during active live monitoring; click **Finish monitoring** before changing it.
- Every recipient gets a separate message. A confirmed provider response is displayed as **Sent · awaiting reply**, never as agreement or a read receipt.
- On a failed or uncertain send, receipts for earlier messages are kept and the remaining batch stops. No automatic resend occurs. Check the actual chat before creating another proposal.
- Replies must match the known platform identity and current reference or quoted message. Unknown senders, stale references, unrelated messages and duplicates do not count.
- Inbound replies are persisted in a local inbox before model interpretation.
- Corrections sent as new messages can change a previous answer. Edits to an already processed message are not tracked; send a new reply instead.
- Silence, delivery success and “maybe” never count as acceptance. Poll failures are visible in Connections; missing replies remain pending.
- Zoom queries up to 500 messages per contact since the proposal and reports a limit error rather than silently claiming completion. Discord catches up in batches with a persisted cursor. These bounds suit a small demo, not a high-volume deployment.
- **Finish monitoring** does not retract messages, cancel meetings or update invitations.

## Run and develop

Requirements: Node.js 22.12+ or 24, npm, and Ollama. cloudflared is needed only for the built-in Zoom authorization connection. These tools are already installed on this computer.

```bash
cd /Users/yeungyingyau/Developer/dayflow
npm install
npm run calendar:build
npm run build
npm run launch
```

The launcher starts the local model server if needed and opens Dayflow on your Mac. Keep the terminal running. `localhost:4317` is the Mac’s dashboard; participants interact through their messaging apps.

For development, stop the existing app and run `npm run dev`, then open `http://localhost:5173`. `npm run build` updates the production UI; `npm start` starts the server without opening a browser.

If needed on another Mac:

```bash
brew install ollama cloudflared
ollama serve
# In another terminal:
ollama pull qwen3:4b
```

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Telegram stopped receiving | Use one running Dayflow process and a dedicated bot with no webhook. Click Check Telegram connection. |
| Discord returns 403 | Check server/channel permission overrides, including history and send permissions. |
| Discord replies are empty or ignored | Enable Message Content Intent; reply to the actual proposal or include its #DF reference. |
| Zoom authorization fails | Check development credentials, exact redirect URL/allow list, scopes, and whether your organization requires app approval. |
| Zoom token expires | Click Check Zoom connection; if renewal fails, authorize again. |
| Zoom send/read returns 400 or 403 | Confirm the selected person is an existing Team Chat contact and the app has both read and write scopes. |
| Missing response | Check the platform, identity and current reference. Coworkers should send a new reply, not edit an old message. |
| Settings are locked | Finish monitoring the active live proposal before editing connections. |

## Code map

```text
src/App.tsx             Dashboard, approval and shared response list
src/Connections.tsx     Platform setup, Discord/Zoom participant routing
shared/types.ts         Coworkers, platforms, proposals and delivery state
native/CalendarBridge.swift  Native EventKit permission/read/write helper
server/calendar-bridge.ts   Private local helper IPC
server/day-planner.ts       Whole-day scheduling constraints
server/calendar.ts          Check-ins, plan approval and calendar commit
src/CalendarWorkspace.tsx   Real calendar timeline and complete plan review
server/app.ts           Local API, transport routing, isolated OAuth callback
server/engine.ts        Delay detection, approval and response transitions
server/telegram.ts      Private owner pairing, approvals and bot polling
server/discord.ts       Channel messages and reply polling
server/zoom.ts          User OAuth, token refresh, contact sends/replies
server/transport.ts     Shared receipts and reply correlation
server/inbox.ts         Durable incoming reply queue
server/llm.ts           Local model and grounded interpretation
server/store.ts         Owner-only local settings and state
server/tunnel.ts        Temporary OAuth callback connection
```

Settings, tokens and received replies stay under `.local` with owner-only permissions; the directory and `.env` are ignored by Git. Tokens and client secrets are omitted from dashboard API responses. Existing proposals from the previous transport are archived in `.local/state-before-social.json`, if present. Telegram owner pairing and model configuration are retained. Legacy Telegram coworker rows are archived to `.local/coworkers-before-owner-only-telegram.json` and removed from active recipients; proposals involving them are archived and invalidated. Coworkers must be added with their Discord ID or Zoom email.

The dashboard binds to loopback port **4317** with host/origin checks. The separate public listener on **4319** exposes only the state-validated Zoom OAuth callback, not settings, approvals or the UI. This remains a single-operator local demo.

## Verification

```bash
npm run build
npm test
npm run test:e2e
npm run test:llm
```

Tests use isolated data and mocked provider HTTP responses, covering approval gates, mixed-platform routing, reply identity/correlation, owner-only Telegram, partial failures, OAuth state and token refresh. Browser tests use ports 4318/4320. No real coworker messages are sent by automated tests. Live Discord and Zoom exchanges require your credentials and participant rehearsal.

## References

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Discord bot setup](https://docs.discord.com/developers/quick-start/getting-started)
- [Discord message API](https://docs.discord.com/developers/resources/message)
- [Zoom user OAuth](https://developers.zoom.us/docs/integrations/oauth/)
- [Zoom Team Chat API](https://developers.zoom.us/docs/api/chat/)
- [Ollama chat API](https://docs.ollama.com/api/chat)

Apple integration references: [EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store), [iCloud Calendar setup](https://support.apple.com/en-gb/guide/icloud/mm15eb200ab4/icloud).
