# Design

## Source of truth
- Status: Active. Last refreshed: 2026-09-12.
- Primary surfaces: local dashboard, Connections dialog, Telegram approval card.
- Evidence: user's lunch-overrun scenario and two-hour hackathon constraint. New project; no existing assets.

## Brand
- Dayflow: calm, observant, considerate. Trust comes from visible evidence, explicit approval and accurate delivery labels.
- Avoid exaggerated claims of autonomy, hidden simulations, dense configuration in the main flow.

## Product goals
- Complete detect → approve → WhatsApp proposal → collect replies → report loop.
- Demonstrate the workflow in 90 seconds with labelled scenario replay.
- Non-goals: native background tracking, automatic calendar mutation, multi-user hosting.
- Success: real WhatsApp send only after approval; no acceptance inferred from silence.

## Personas and jobs
- Busy professional in a conversation, wants one-tap coordination.
- Presenter needs deterministic reset and clear evidence without waiting 15 minutes.

## Information architecture
- Dashboard: status, schedule, delay evidence, next action, responses, activity.
- Connections: Twilio credentials, coworker phone numbers, signed webhook setup, Telegram pairing, local model.
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
- Plain English. “Propose” until everyone agrees; never claim the calendar was updated.
- “Scenario replay” for seeded time/location. “WhatsApp live” only for real Twilio WhatsApp transport.

## Implementation constraints
- React/Vite, Express/TypeScript, local JSON storage, Ollama, Twilio WhatsApp API with signed webhooks, Telegram long polling.
- Single local operator. Dashboard on loopback port 4317; a separate webhook-only listener on 4319 is exposed through a temporary tunnel. Secrets stay server-side.
- Verify state transitions and approval gate with tests; desktop/mobile browser checks and screenshots.

## Open questions
- User to enter Twilio credentials, join the WhatsApp testing environment with coworkers, and pair Telegram in the local Connections UI.
- Qwen3 4B is installed and verified locally.

## WhatsApp delivery contract
- Each coworker receives a separate message from the Twilio test number. No existing WhatsApp group access.
- Track queued, delivered, read, failed, and unknown delivery independently of acceptance. Stop after partial send failures; do not resend automatically.
- Coworkers must join the sandbox and send hello before proposals can be sent. Show each recent messaging window in Connections.
