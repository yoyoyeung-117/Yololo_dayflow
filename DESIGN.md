# Design

## Source of truth
- Status: Active. Last refreshed: 2026-09-12.
- Primary surfaces: local dashboard, Connections dialog, Telegram approval card.
- Evidence: user's lunch-overrun scenario and two-hour hackathon constraint. New project; no existing assets.

## Brand
- DayMade: calm, observant, considerate. Trust comes from visible evidence, explicit approval and accurate delivery labels.
- Avoid exaggerated claims of autonomy, hidden simulations, dense configuration in the main flow.

## Product goals
- Complete detect → approve → coworker proposal → collect replies → report loop.
- Demonstrate the workflow using real Calendar events and the current clock.
- Non-goals: native background tracking, unapproved calendar mutation, multi-user hosting.
- Success: real coworker send only after approval; no acceptance inferred from silence.

## Personas and jobs
- Busy professional in a conversation, wants one-tap coordination.
- Presenter can select a future event or report an overrun immediately, with a clear approval boundary.

## Information architecture
- Dashboard: status, schedule, delay evidence, next action, responses, activity.
- Connections: Telegram owner pairing, Discord channel setup, Zoom user OAuth, per-person platform routing, local model.
- Guide: README plus in-app setup steps.

## Design principles
- Show real calendar facts and the current time before suggestions. Label user-supplied transition estimates.
- Make one next action prominent. State missing integration requirements in place.
- Assumption: desktop presentation with mobile Telegram approval.

## Visual language
- Cream canvas, deep evergreen navigation, lime accent, coral for delay risk.
- System sans typography, large clear headings; monospace for time and codes.
- 8px spacing rhythm, 16–24px card radius, subtle borders and minimal shadows.
- Live clock, Calendar event timeline and lucide icons. Short transitions; no decorative animation loops.

## Components
- Sidebar, evidence chips, timeline, approval card, response rows, setup dialog, toast.
- States: observing, preparing, needs approval, sending, awaiting replies, agreed, needs attention, dismissed, delivery uncertain.
- Tokens owned by src/styles.css.

## Accessibility
- Target WCAG AA. Semantic buttons and labels, visible keyboard focus, accessible dialog and status messages.
- Status communicated with words and icons as well as color. Respect reduced motion.

## Responsive behavior
- Desktop two-column workspace; single column below 1000px; compact navigation below 700px.
- Minimum 44px primary touch targets. No essential hover-only content.

## Interaction states
- Loading: disable duplicate actions and explain work underway.
- Empty: guide to next step. Error: actionable inline message; retain existing state.
- Success: show actual recipients and replies. Offline: flag polling failure; never invent delivery or acceptance.

## Content voice
- Plain English. “Propose” until everyone agrees; claim Calendar was updated only when the Apple Calendar helper returns save receipts.
- “Plan my day” for real event planning. Show the actual Calendar timezone, date and clock; approvals authorize live coordination.

## Implementation constraints
- React/Vite, Express/TypeScript, local JSON storage, Ollama, Telegram long polling, Discord REST polling, Zoom user OAuth and Team Chat REST polling.
- Single local operator. Dashboard on loopback port 4317; an isolated OAuth callback listener on 4319 can be exposed through a temporary tunnel for Zoom authorization. Secrets stay server-side.
- Verify state transitions and approval gate with tests; desktop/mobile browser checks and screenshots.

## Open questions
- User to pair Telegram as the private agent channel, configure Discord for coworkers and/or authorize Zoom. Only platforms used by selected coworkers affect readiness.
- The local model target is Qwen3.6 35B through Ollama. Verify actual structured-output inference when changing the configured model.

## Messaging contract
- Telegram is exclusively you ↔ DayMade: private suggestions, approvals and results. Coworkers use Discord or Zoom Team Chat: mentions in a selected Discord channel or direct messages to Zoom contacts.
- Dashboard shows all three platform statuses and one combined response list with per-person platform badges.
- Owner approval shows exact destinations, channel and meeting time. No coworker sends during connection checks.
- Telegram is excluded from participant choices and backend routing. Legacy Telegram coworker invitations have no effect; owner pairing is preserved.
- A platform receipt means sent, not read or agreed. Stop on partial send failure or uncertainty and preserve successful receipts.
- Telegram and Discord need no public ingress. Zoom’s temporary connection is for OAuth authorization only; replies use REST polling.
- Setup uses platform tabs and a shared participant list. Only included participants affect readiness.

## Apple Calendar workspace
- My calendar is the default workspace for event rules and incoming teammate requests. Plan my day replaces Practice scenario. Both calendar views expose the future-meeting reschedule form and a direct per-event action. Both use the same real Calendar state.
- Use the existing cream cards, evergreen primary actions, restrained lime accents, rounded controls and responsive grid.
- Connect Apple Calendar with a local EventKit helper. Display real dates/timezone, last successful refresh, permission errors, and the empty-day state.
- Default events to fixed. Explicitly mark editable personal events flexible and map their friends from Connections; invited, all-day and read-only events cannot be moved.
- Show the entire day, a remaining-time input, transition buffer and before/after plan. Show exact message text, recipients and destination before approval.
- Calendar changes happen only after the owner approves the complete plan and all named friends agree. Show actual calendar receipts as success; preserve blocked/uncertain states.
- Monitoring means an end-of-event Telegram check-in while this Mac runs. Do not claim background iPhone location detection. iCloud calendars sync through Apple; local calendars stay on this Mac.

## Autonomous negotiation
- Initial approval delegates coordination for the named meeting and participants for today, preserving duration and checking Calendar before each alternative. Up to six proposal rounds within thirty minutes; no repeated owner time decisions.
- Check a friend's suggested time first. Otherwise choose the next untried free slot with the transition buffer. All participants must confirm each newly proposed time.
- Ask unclear respondents directly for clarification. Never treat silence, a conditional answer, or a sent receipt as agreement.
- Display round history and reasons. Report either the final confirmed time or a clear terminal no-agreement outcome. Delivery uncertainty still stops automatic sends.
- Existing approvals without the delegation field retain their original scope; start a fresh proposal for the new behavior. Plan my day and My calendar share approval, negotiation and calendar writes. Earlier seeded proposals cannot be newly approved or recreated.

## Teammate-initiated coordination
- My calendar includes a “Requests from your friends” inbox and a visible listening toggle. New top-level Discord messages or Zoom Team Chat contact messages can initiate a request without an existing DayMade proposal. Replies remain bound to their original proposal.
- Match only an enabled saved friend to an editable, future, flexible event today with that friend selected. Require a clear time and an unambiguous title or original start time. Ask for clarification when uncertain.
- If the requested slot is free, show the event, before/after times, timezone, requester and participants in Telegram. Offer Accept, Another time (a reply prompt), and Decline, with matching dashboard actions.
- The user's standing busy-slot policy permits automatically declining an unavailable time and coordinating a free alternative. Preserve duration and a ten-minute transition buffer; never disclose the private conflicting event's details. A free earlier time is allowed for these requests.
- Accepting a request delegates the existing six-round/thirty-minute negotiation. The initiator's explicit request counts as consent only for that exact first-round time; all other participants and all subsequent rounds need new agreement. Confirm the final saved time to the owner and friends.
- Disconnect controls in messaging setup and Calendar stop coordination and new requests, invalidate pending approvals and persist across restart. Keep credentials and native permission for reconnecting. Re-enable request listening explicitly after reconnecting. Already sent messages and already saved events are not undone.

## Real-day planning contract
- Show a ticking clock in the Calendar timezone, current date, actual event titles/durations, current event and next-event countdown. Refresh connected Calendar reads once per minute while the workspace is open; stale data must be labelled and cannot create a plan for a different day.
- Future-event rescheduling uses a fresh Calendar read and requires the event to be editable, future, busy and explicitly flexible. Preserve duration, day boundaries, fixed events and the supplied transition buffer. Conflicts block approval.
- An explicit review shows the selected event's true before/after times and mapped participants. Send messages only after approval; commit only after all participants agree and the last Calendar check passes.
- Retire fixed-clock actions, invented lunch/office/map data and seeded proposal endpoints. The old practice URL opens Plan my day. Keep previously sent conversation receipts available until monitoring stops.

## Real travel and online meetings
- Product branding is DayMade, with sidebar identity Yoyo / Yololo. All planning surfaces use actual Calendar titles, times and venues; absent data has an explicit empty state.
- Apple Maps supplies route duration, distance, a real map snapshot and a directions link. Show the matched places. Walking and driving are supported; transit is opened externally without a made-up ETA.
- Travel origin is a user-shared browser location or entered current address. Timestamp it, reject very poor accuracy, expire after thirty minutes, and clear it on disconnect. Never imply that a snapshot continuously tracks an iPhone.
- Label travel separately from the chosen buffer. Show leave-by time and predicted readiness assuming immediate departure. Route checks expire visibly; failed checks suppress automated travel advice.
- Opt-in Telegram monitoring sends deduplicated late-arrival and ten-minute online reminders. Online events carry the actual join URL; full event notes remain private. No Apple Calendar alarm mutation is implied.
- A travel warning can prepare a fresh Calendar proposal after checking the next free slot and estimated arrival. Owner approval remains mandatory for coworker sends and Calendar changes. Subsequent negotiations must not propose a slot earlier than the travel plan’s earliest arrival.
