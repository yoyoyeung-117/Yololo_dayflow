# DayMade

DayMade spots a likely delay, asks for your approval privately on **Telegram**, sends meeting proposals through **Discord and Zoom Team Chat**, collects replies, and reports back to you.

**Open the app: http://localhost:4317 → My calendar.**

Your existing Telegram owner pairing and Ollama settings are retained. WhatsApp and Twilio have been removed. The open-weight model **Qwen3.6 35B** runs locally through Ollama.

## The platform roles

| Platform | Who communicates | Purpose |
| --- | --- | --- |
| Telegram | You ↔ DayMade | Private suggestions, approval buttons, progress and results |
| Discord | You and coworkers, with DayMade coordinating | Proposals and coworker replies in the selected team channel |
| Zoom Team Chat | You and coworkers, with DayMade coordinating | Proposals and replies in existing contact conversations |

Coworkers do not join the Telegram bot. Participant destinations are restricted to Discord and Zoom in both the interface and API.

## Continue from here

1. In **Connections → Telegram**, check your saved owner connection. This is your private channel with the agent.
2. Connect **Discord** or **Zoom Team Chat** using the instructions below. You can use either or both.
3. Under **Your meeting participants**, add coworkers with a Discord user ID or Zoom contact email. Choose **Include in meeting** for the people to contact, then **Save coworkers**.
4. In **My calendar**, connect Apple Calendar, allow a future event to be rescheduled, and select the friends who attend it.
5. In **My calendar** or **Plan my day**, click **Change time & ask friends** on the event, enter a new start time in **Move a meeting**, then click **Review meeting change**. Review the actual before/after times and recipients. You can also report an overrun in a current event.
6. Approve on Telegram or the Mac. DayMade coordinates with those friends, checks Calendar before alternatives, and saves once everyone agrees.


If you have not paired the owner yet, use the verified **@BotFather** in Telegram, send `/newbot`, and paste its token into Connections. Click **Save & pair Telegram** and open the private owner pairing link. Only you use this pairing link. Use a dedicated bot without an existing webhook or another polling process.

## Real venues, maps and reminders

The old practice URL opens the real Calendar planner. Seeded scenario creation and simulated replies return HTTP 410. Events and venues are never invented, and missing locations remain visibly missing.

1. Add the actual venue to each in-person event in Apple Calendar. A selected map location supplies coordinates; otherwise Apple Maps searches the venue text. Check the matched places on the map, particularly for ambiguous addresses.
2. In **Travel & meeting reminders**, choose **Use my location** (this Mac browser’s permission) or enter your current full address. Location is a snapshot, not background iPhone tracking; update it when moving or after 30 minutes.
3. Select **Driving / taxi** or **Walking**, and enter your extra buffer. The helper requests an actual Apple Maps route and map snapshot; no API key is required. The visible route opens in Apple Maps for navigation. MTR/bus estimates are not implemented: choose transit in Apple Maps instead. Taxi waiting and parking belong in your buffer.
4. Enable **Remind me on Telegram**. While the Mac and server run, DayMade refreshes Calendar and the route about once per minute. It compares travel plus buffer with the real next in-person meeting. Old or imprecise origins, missing venues and failed routes produce no fictional ETA.
5. A late-arrival warning offers **Find a later time & review with me** for flexible personal events. DayMade rereads Calendar and Maps, finds a free slot after estimated arrival, and sends an approval card. Only approval contacts the event’s selected friends. Negotiation preserves the arrival lower bound, duration and fixed appointments.
6. Online events show their actual Zoom/Meet/Teams/Webex joining link, extracted from the event URL, location or notes. Full notes are not exposed. Telegram sends one reminder within ten minutes of the start; the DayMade calendar also shows the link and countdown. This does not add or edit Apple Calendar alarms.

**Disconnect travel & reminders** clears the stored origin and pending travel buttons. Disconnecting Calendar or Telegram also disables this monitoring. Calendar access may need **Allow Full Access** again after rebuilding the signed native helper. Reminder failures are visible and are not blindly retried.

## Add Discord

Discord delivery uses a bot in one regular server text channel. It mentions each selected coworker in a separate message. **All members with access to that channel can see these proposals.**

1. Open [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. On **Bot**, copy/reset the **bot token**. Enable **Message Content Intent** so DayMade can read normal replies.
3. Under **Installation**, select **Guild Install**, add the `bot` scope, and grant **View Channels**, **Send Messages**, and **Read Message History**. Install the bot into a server you manage.
4. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your dedicated text channel and choose **Copy Channel ID**.
5. In DayMade **Connections → Discord**, enter the token and channel ID; click **Save & connect Discord**. This checks bot identity and channel history access, and enables Message Content Intent through Discord’s application API when available. If Discord requires approval for that intent, setup reports the required action. No channel message is sent.
6. Add a coworker with platform **Discord**. Right-click that person in Discord, copy their **User ID**, paste it into their row, and save.
7. After your approval, they receive a mention in that channel. They can select **Reply** on their proposal and type `yes`, `no`, or an alternative time. **No @bot mention is needed, and the reply ping can be off.** A new message can instead include the current reference, for example `#DF-ABC123 yes`.

The bot polls this channel approximately every six seconds while monitoring a live proposal. No public webhook or Discord Gateway connection is required. Use a quiet demo channel. Server permission overrides can still prevent sending; any error appears on that recipient instead of being reported as success.

## Add Zoom Team Chat

Zoom delivery sends from **your authorized Zoom account** to existing **Team Chat contacts**. It does not join a video call, send in-meeting chat, or create/reschedule Zoom meetings.

### Configure the app

1. Open [Zoom App Marketplace](https://marketplace.zoom.us/develop/create) and create a **General App** using **user-managed OAuth**. Use your app’s development credentials and local-test/distribution settings.
2. Add these **user-level** granular scopes:
   - `user:read:user` — verify the authorized account.
   - `team_chat:write:user_message` — send a Team Chat message.
   - `team_chat:read:list_user_messages` — collect contact replies.
3. Enter the **Client ID** and **Client Secret** in DayMade **Connections → Zoom** and click **Save Zoom settings**.
4. Click **Start Zoom authorization connection**. DayMade starts cloudflared on its isolated OAuth callback listener, port **4319**.
5. Copy the exact **Zoom OAuth Redirect URL** shown in DayMade, ending in `/oauth/zoom/callback`. Save it as the app’s OAuth Redirect URL and in its OAuth allow list in Zoom.
6. Back in DayMade, click **Create Zoom authorization link**, then **Authorize on Zoom**. Sign in with the Zoom account that will send proposals and accept the requested access. Return to DayMade when the connection succeeds.
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

## Real time and real calendar

**Plan my day replaces Practice scenario.** The former `?view=demo` link opens the real planner; `?view=plan` is its current URL. The clock ticks in the Mac Calendar timezone, and the timeline shows real event dates, durations, past/current status and minutes until the next event. While the workspace is open, connected Calendar data refreshes about once per minute and whenever you click Refresh day. The planner rereads Calendar before preparing, approving and saving changes.

Use **Move a meeting** to reschedule an editable, future, flexible event today. Its linked friends come from the event's configuration. Choose a start time and transition buffer; conflicting times produce a visible blocker. An earlier future time is supported. **Need a little longer?** calculates the ripple from a current or recently ended event across later appointments.

Every new proposal uses real dates, event titles, durations and selected friends. Approval can send real Discord/Zoom messages and save real Calendar changes after agreement. No fake event or clock is used when Calendar is empty, disconnected or stale. The old seeded-scenario creation, approval and notification endpoints are retired; already sent conversations can still be reviewed and stopped.

Travel/transition minutes are supplied by you. DayMade does not claim to measure your location or calculate a real route.

## Apple Calendar on Mac and iPhone

1. Open **My calendar → Connect Apple Calendar** and allow **Full Access** for **Dayflow Calendar** if macOS asks. No Apple password or Microsoft registration is needed. If denied, enable it in System Settings → Privacy & Security → Calendars.
2. Enable iCloud Calendar on your Mac and iPhone using the same Apple Account. DayMade reads calendars already available on the Mac. Only iCloud-backed events sync to iPhone; “On My Mac” events stay local.
3. Add your Discord friends in **Connections**, with each person's Discord user ID. On the calendar timeline, mark future personal events **Allow this event to move later**, then select the friends for that event. No selected friends means personal time and no social messages. Invitations, all-day events and read-only calendars stay fixed.
4. Turn on **Check in on Telegram when an event ends**. Keep this Mac awake and DayMade running. A Telegram check-in asks whether you're finished or need another 15/30 minutes. Monitoring starts when enabled; it does not send retrospective check-ins for earlier events.
5. Or select a current/recently ended event on the dashboard, enter remaining extra minutes and a travel/transition buffer, then **Review the rest of my day**. The planner preserves durations, uses available gaps and shifts flexible appointments around fixed ones. Conflicts with fixed commitments or moves past midnight block approval.
6. Review **every before/after time, friend and exact message**. Approve the full plan on Telegram or on the Mac. Plans use real Discord/Zoom messages after approval.
7. Each affected meeting has a separate reference and reply inbox. All named friends must explicitly accept before any calendar save. A decline starts another calendar-checked round automatically. A suggested time is tried first if free; otherwise the agent offers the next suitable slot. Unclear replies get a direct clarification request. Every changed time resets all acceptance statuses, so everyone must confirm the latest proposal.
8. DayMade rereads the day before sending and before saving. During delegated negotiation, unrelated Calendar edits can be rebased; new conflicts trigger another round. An external edit to a target event stops coordination without overwriting it. One batch updates only the selected event occurrences. The current overrun event's stored end time is not extended. The Mac reports confirmed saves privately on Telegram.

**Five-minute rehearsal with real events:** in Apple Calendar, add a personal “Lunch demo” ending in one minute and a “Coffee demo” starting in about 15 minutes. Put Coffee in an editable iCloud calendar, without Apple invitees. Refresh DayMade, mark Coffee flexible, and select your Discord friend. Enable check-ins, wait for Lunch to end, and tap **Need 30 more min** on Telegram. Review and approve the resulting message; your friend replies with its `#DF-… yes` reference. Verify Coffee moves in Calendar and syncs to iPhone. Delete your demo events afterward in Calendar. No rehearsal events are created automatically.

An existing active conversation from the earlier scenario must be stopped before a Calendar plan can send. **Stop this plan** stops monitoring but does not retract already sent messages. Approvals expire after ten minutes; coordination stops after thirty minutes or when a proposed time passes. Restart during delegated coordination resumes monitoring; a restart during an uncertain send still requires inspection. A restart or error during Calendar saving is treated as uncertain: inspect Calendar before trying again; the app never retries writes automatically.

The schedule planner is deterministic. The local open model interprets friend replies with the existing evidence checks; it cannot select recipients or authorize calendar writes. All-day entries are displayed but excluded from timed travel calculations. DayMade cannot read your friends' private calendars, estimate live traffic or detect an actual overrun from Calendar alone.

## Autonomous negotiation

Start a **new proposal** to use the updated behavior. Existing proposals retain the scope of their earlier approval. Your first approval now delegates the back-and-forth to DayMade: same meeting duration and participants, alternative times today, at most six proposal rounds within thirty minutes.

| Friend’s reply | Agent action |
| --- | --- |
| `For sure!`, `np`, `no problem`, `yep` | Record acceptance for the current proposal |
| `no`, `can't make it` | Read Calendar, find the next untried free slot, propose it to everyone |
| `how about 15:00`, `14:30 ok?` | Check that suggested time first; offer another slot if busy |
| `maybe`, `yes if…`, an ambiguous date or time | Ask that friend directly to clarify |

Use Discord’s **Reply** on the latest proposal (or include its `#DF-…` reference). No @bot mention is required. Each alternative gets a new reference. Old approvals, old replies and acceptance of an earlier time cannot approve the new one. The dashboard keeps round history and the reason for each alternative.

The agent reports the final time privately. Both calendar views share the same plan and save event changes only once everyone has agreed. If no free slot remains, six proposals fail, the coordination window expires, or a friend cannot clarify after two requests, it reports a terminal **no agreement** result. It does not manufacture agreement or send indefinitely. Delivery uncertainty stops further automatic messages.

Alternative slots are checked against the real Apple Calendar on this Mac. The planner also reserves the other proposed event moves when finding a new slot, so it cannot book two events into the same gap.

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
cd /Users/user_name/Developer/dayflow
npm install
npm run calendar:build
npm run build
npm run launch
```

The launcher starts the local model server if needed and opens DayMade on your Mac. Keep the terminal running. `localhost:4317` is the Mac’s dashboard; participants interact through their messaging apps.

For development, stop the existing app and run `npm run dev`, then open `http://localhost:5173`. `npm run build` updates the production UI; `npm start` starts the server without opening a browser.

If needed on another Mac:

```bash
brew install ollama cloudflared
ollama serve
# In another terminal:
ollama pull qwen3.6:35b
```

## Two-way meeting changes

1. Open [DayMade](http://localhost:4317) → **My calendar** and refresh Apple Calendar.
2. On a future personal meeting today, select **Allow this event to be rescheduled**, then select the friends who attend. Save their Discord user IDs or Zoom contact emails in Connections first. Calendar invitations and read-only events stay fixed.
3. Keep **Handle teammate rescheduling requests** enabled. Telegram must be paired, Calendar connected, and the selected friends' platforms connected.
4. A saved friend posts a **new message** in the configured Discord channel (or the connected Zoom Team Chat contact conversation): `Can we move Coffee from 17:00 to 17:30?` Use the exact event title or original time and clear 24-hour times. This demo handles today, in the Calendar timezone.
5. If free, your Telegram card offers **Accept 17:30**, **Another time**, or **Decline request**. For another time, reply to the bot's new prompt with e.g. `18:00`. The same controls are in the web inbox.
6. If busy, DayMade automatically tells the friends that time is unavailable and proposes the first free alternative afterward, preserving duration and a 10-minute buffer. It does not reveal private event details.
7. The requester already agreed to the exact time they requested. Other friends confirm using **Reply** on their DayMade proposal or its current `#DF-…` reference. A different time requires everyone to agree again. DayMade checks Calendar on each new round, saves after agreement, and reports the confirmed time on Telegram and to the friends.

Plain-language English scheduling requests are matched conservatively; ambiguous requests receive a clarification instead of moving an event. Existing reply interpretation still uses the local open model with grounded rules for “For sure!”, “np”, declines and counterproposals. Edited old messages are not new requests. Waiting owner cards expire after ten minutes; one meeting is coordinated at a time. This does not add automatic iPhone location tracking or access to friends' private calendars.

### Disconnect for debugging

In **Connections**, each Telegram / Discord / Zoom tab has a **Disconnect** button. Apple Calendar has its own button in **My calendar**. Disconnect pauses coordination and incoming requests, invalidates pending approvals and stays disconnected after restart. Saved credentials, owner pairing and macOS Calendar permission are kept. A send or Calendar write already in progress must finish before disconnecting; completed actions are not undone.

To resume, reconnect the integration, then turn **Handle teammate rescheduling requests** back on in My calendar. Messages posted while paused are skipped, so ask your friend to send a fresh request. End-of-event check-ins have a separate toggle.

## Local model configuration

This Mac uses `qwen3.6:35b` through local Ollama. The model download is approximately 23 GB; this setup targets the Mac's 48 GB of unified memory. There are no model API charges. Existing saved settings take precedence over the default model.

To verify a model before switching the app:

```bash
npm run test:llm -- qwen3.6:35b
```

In **Connections → Open model**, use `http://127.0.0.1:11434` and model name `qwen3.6:35b`. The connection check verifies installation; `test:llm` exercises actual inference and requires model responses rather than the rules fallback. Model choice does not itself replace the request parser or scheduling rules.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Telegram stopped receiving | Use one running DayMade process and a dedicated bot with no webhook. Click Check Telegram connection. |
| Discord returns 403 | Check server/channel permission overrides, including history and send permissions. |
| Discord replies are empty or ignored | Reconnect Discord so DayMade checks/enables Message Content Intent. Use Reply on the actual proposal; no @bot mention or reply ping is needed. If Discord requires intent approval, complete that in Developer Portal → Bot. |
| Zoom authorization fails | Check development credentials, exact redirect URL/allow list, scopes, and whether your organization requires app approval. |
| Zoom token expires | Click Check Zoom connection; if renewal fails, authorize again. |
| Zoom send/read returns 400 or 403 | Confirm the selected person is an existing Team Chat contact and the app has both read and write scopes. |
| Missing response | Check the platform, identity and current reference. Coworkers should send a new reply, not edit an old message. |
| Settings are locked | Finish monitoring the active live proposal before editing connections, or use Disconnect to stop coordination. |
| A friend’s new request is ignored | Enable request listening; link that saved friend to a flexible future event today. Post a new message with the exact title or original time and the requested time. |

## Code map

```text
src/App.tsx             Navigation and previously sent conversation controls
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
server/requests.ts      Teammate request intake, calendar checks and owner responses
src/RequestsInbox.tsx   Two-way request inbox and custom-time controls
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
