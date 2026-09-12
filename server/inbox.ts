import type { Engine } from './engine.js';
import type { Store } from './store.js';
import { correlateReply, type Incoming } from './transport.js';

type Event = { proposalId: string; incoming: Incoming };
export class ReplyInbox {
  private events: Event[];
  private draining = false;
  constructor(private engine: Engine, private store: Store) { this.events = store.read('social-inbox', []); }
  async receive(incoming: Incoming) {
    const proposal = this.engine.state.proposal;
    if (!proposal || !['preparing', 'sending', 'waiting', 'attention', 'agreed', 'uncertain'].includes(this.engine.state.phase) || !correlateReply(incoming, proposal)) return;
    if (this.engine.state.processedMessages.includes(`${incoming.platform}:${incoming.messageId}`) || this.events.some(e => e.incoming.platform === incoming.platform && e.incoming.messageId === incoming.messageId)) return;
    if (this.events.length >= 1000) throw new Error('The reply queue is full. Finish processing the current conversation first.');
    this.events.push({ proposalId: proposal.id, incoming }); this.store.write('social-inbox', this.events);
  }
  async drain() {
    if (this.draining || ['preparing', 'sending'].includes(this.engine.state.phase)) return;
    this.draining = true;
    try {
      while (this.events.length) {
        if (['preparing', 'sending'].includes(this.engine.state.phase)) break;
        const event = this.events[0], proposal = this.engine.state.proposal;
        if (proposal?.id === event.proposalId) {
          const reply = correlateReply(event.incoming, proposal);
          if (reply) await this.engine.reply(proposal.id, reply.personId, reply.text, reply.messageId);
        }
        this.events.shift(); this.store.write('social-inbox', this.events);
      }
    } finally { this.draining = false; }
  }
}
