# Design

## Source of truth
- Status: Active. Last refreshed: 2026-09-12.
- Primary surfaces: local dashboard, Connections dialog, Telegram approval card.
- Evidence: user's lunch-overrun scenario and two-hour hackathon constraint. New project; no existing assets.

## Brand
- Dayflow: calm, observant, considerate. Trust comes from visible evidence, explicit approval and accurate delivery labels.
- Avoid exaggerated claims of autonomy, hidden simulations, dense configuration in the main flow.

## Product goals
- Complete detect → approve → coworker proposal → collect replies → report loop.
- Demonstrate the workflow in 90 seconds with labelled scenario replay.
- Non-goals: native background tracking, unapproved calendar mutation, multi-user hosting.
- Success: real coworker send only after approval; no acceptance inferred from silence.

## Personas and jobs
- Busy professional in a conversation, wants one-tap coordination.
- Presenter needs deterministic reset and clear evidence without waiting 15 minutes.

## Information architecture
- Dashboard: status, schedule, delay evidence, next action, responses, activity.
- Connections: Telegram owner pairing, Discord channel setup, Zoom user OAuth, per-person platform routing, local model.
- Guide: README plus in-app setup steps.

## Design principles
- Show observed facts before suggestions. Separate delivery mode from simulated sensor inputs.
- Make one next action prominent. State missing integration requirements in place.
- Assumption: desktop presentation with mobile Telegram approval.

## Visual language
- Cream canvas, deep evergreen navigation, lime accent, coral for delay risk.
- System sans typography, large clear headings; monospace for time and codes.
- 8px spacing rhythm, 16–24px card radius, subtle borders and minimal shadows.
- Inline SVG map and lucide icons. Short transitions; no decorative animation loops.

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
- “Scenario replay” for seeded time/location. “Live messages” for real transport; “Simulated messages” for replay. Display HKT explicitly.

## Implementation constraints
- React/Vite, Express/TypeScript, local JSON storage, Ollama, Telegram long polling, Discord REST polling, Zoom user OAuth and Team Chat REST polling.
- Single local operator. Dashboard on loopback port 4317; an isolated OAuth callback listener on 4319 can be exposed through a temporary tunnel for Zoom authorization. Secrets stay server-side.
- Verify state transitions and approval gate with tests; desktop/mobile browser checks and screenshots.

## Open questions
- User to pair Telegram as the private agent channel, configure Discord for coworkers and/or authorize Zoom. Only platforms used by selected coworkers affect readiness.
- Qwen3 4B is installed and verified locally.

## Messaging contract
- Telegram is exclusively you ↔ Dayflow: private suggestions, approvals and results. Coworkers use Discord or Zoom Team Chat: mentions in a selected Discord channel or direct messages to Zoom contacts.
- Dashboard shows all three platform statuses and one combined response list with per-person platform badges.
- Owner approval shows exact destinations, channel and meeting time. No coworker sends during connection checks.
- Telegram is excluded from participant choices and backend routing. Legacy Telegram coworker invitations have no effect; owner pairing is preserved.
- A platform receipt means sent, not read or agreed. Stop on partial send failure or uncertainty and preserve successful receipts.
- Telegram and Discord need no public ingress. Zoom’s temporary connection is for OAuth authorization only; replies use REST polling.
- Setup uses platform tabs and a shared participant list. Only included participants affect readiness.

## Apple Calendar workspace
- My calendar is the default workspace; Practice scenario keeps seeded inputs in a separate view.
- Use the existing cream cards, evergreen primary actions, restrained lime accents, rounded controls and responsive grid.
- Connect Apple Calendar with a local EventKit helper. Display real dates/timezone, last successful refresh, permission errors, and the empty-day state.
- Default events to fixed. Explicitly mark editable personal events flexible and map their friends from Connections; invited, all-day and read-only events cannot be moved.
- Show the entire day, a remaining-time input, transition buffer and before/after plan. Show exact message text, recipients and destination before approval.
- Calendar changes happen only after the owner approves the complete plan and all named friends agree. Show actual calendar receipts as success; preserve blocked/uncertain states.
- Monitoring means an end-of-event Telegram check-in while this Mac runs. Do not claim background iPhone location detection. iCloud calendars sync through Apple; local calendars stay on this Mac.
