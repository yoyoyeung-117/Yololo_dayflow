import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowRight, ArrowUpRight, Bell, CalendarDays, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Coffee, Copy, ExternalLink, Leaf, LoaderCircle, MapPin, MessageCircle, Navigation, Play, Plug, RotateCcw, Send, Settings2, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import type { Mode, Person, Snapshot } from '../shared/types';

const timeLabel = (time: string) => { const [h, m] = time.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')}`; };
const statusLabel: Record<string, string> = { pending: 'Waiting', accepted: 'Accepted', declined: 'Can’t make it', counterproposal: 'Suggested a time', unclear: 'Needs clarification' };

async function request<T = { ok: boolean }>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M7 7h8a8 8 0 0 1 0 16H7m0-8h17" /></svg></span><span>dayflow<span className="brand-dot">.</span></span></div>;
}

function RouteMap() {
  return <div className="route-map" role="img" aria-label="Illustrative route from lunch at The Corner Café to the office, 20 minutes away. Scenario replay.">
    <svg viewBox="0 0 560 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="560" height="180" fill="#edf1e6" />
      <path d="M0 110L180 175L560 130V180H0Z" fill="#d6e6df" />
      <g fill="#e1e7d7"><rect x="15" y="14" width="100" height="45" rx="8" /><rect x="145" y="-8" width="90" height="72" rx="8" /><rect x="266" y="16" width="90" height="46" rx="8" /><rect x="390" y="0" width="150" height="66" rx="8" /><rect x="62" y="96" width="80" height="53" rx="8" /><rect x="173" y="96" width="116" height="48" rx="8" /><rect x="324" y="98" width="67" height="70" rx="8" /><rect x="425" y="96" width="135" height="45" rx="8" /></g>
      <g stroke="#fafbf6" strokeWidth="15" fill="none"><path d="M0 78H560M130 0V180M250 0V180M407 0V180" /><path d="M0 151L560 163" /></g>
      <path d="M130 118V78H407V115" stroke="#246358" strokeWidth="3" fill="none" strokeDasharray="5 6" strokeLinecap="round" />
      <circle cx="130" cy="118" r="18" fill="#246358" fillOpacity=".12" /><circle cx="130" cy="118" r="7" fill="#246358" stroke="white" strokeWidth="3" />
      <circle cx="407" cy="115" r="7" fill="#cf7859" stroke="white" strokeWidth="3" />
    </svg>
    <span className="map-label cafe"><Coffee size={13} /> The Corner Café</span><span className="map-label office"><MapPin size={13} /> Your office</span>
    <span className="map-duration"><Navigation size={12} /> 20 min</span><span className="map-disclaimer">Illustrative route · fixed travel estimate</span>
  </div>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [connections, setConnections] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [newTime, setNewTime] = useState('14:00');
  const [editing, setEditing] = useState(false);
  const [replyPerson, setReplyPerson] = useState('alex');
  const [replyText, setReplyText] = useState('Yes, that works for me!');
  const refresh = useCallback(async () => { try { setSnapshot(await request<Snapshot>('/api/state')); setOffline(false); } catch { setOffline(true); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1200); return () => clearInterval(timer); }, [refresh]);
  const act = async (name: string, url: string, body = {}) => {
    if (busy) return;
    setBusy(name); setError('');
    try { await request(url, body); await refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(''); }
  };
  if (!snapshot) return <div className="boot"><Brand /><LoaderCircle className="spin" /><p>{offline ? 'Start the server with npm start, then refresh this page.' : 'Making a little room in your day…'}</p></div>;
  const { state, integrations } = snapshot;
  const p = state.proposal;
  const isLive = state.mode === 'live';
  const ready = !isLive || integrations.whatsapp.ready;
  const phaseTitles: Record<string, string> = { observing: 'A little room in your day.', preparing: 'Finding your next best move.', approval: 'A small change. A smoother day.', sending: 'Taking care of the details.', waiting: 'The conversation is in motion.', agreed: 'Everyone’s on the same page.', attention: 'One detail needs your attention.', dismissed: 'You’re in control of your day.', uncertain: 'Let’s check before moving on.' };
  const accepted = p?.people.filter(person => person.status === 'accepted').length || 0;
  const running = ['waiting', 'attention', 'agreed', 'uncertain'].includes(state.phase);
  const expired = p && Date.now() > p.expiresAt;
  const changeMode = async (mode: Mode) => { if (mode !== state.mode) { await act('mode', '/api/replay/reset', { mode }); setEditing(false); } };

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <div className="workspace-label">YOUR PERSONAL COORDINATOR</div>
      <nav aria-label="Main navigation">
        <button className="nav-item active" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><CalendarDays size={19} /> My day <span className="nav-count">2</span></button>
        <button className="nav-item" onClick={() => setConnections(true)}><Plug size={19} /> Connections <span className={`connection-dot ${integrations.whatsapp.connected ? 'connected' : ''}`} /></button>
        <button className="nav-item" onClick={() => document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' })}><Activity size={19} /> Activity</button>
      </nav>
      <div className="sidebar-note"><span className="note-icon"><Leaf size={21} /></span><h3>Stay in the moment.</h3><p>I’ll help with what comes next. You decide what gets sent.</p><div><ShieldCheck size={14} /> Always with your approval</div></div>
      <button className="sidebar-help" onClick={() => setConnections(true)}><CircleHelp size={17} /> Setup & demo guide <ArrowUpRight size={15} /></button>
      <div className="profile"><span className="avatar owner">Y</span><div><strong>{'Your workspace'}</strong><span>Hackathon edition</span></div><Settings2 size={16} /></div>
    </aside>

    <main>
      <header className="topbar"><div><span className="breadcrumb">Workspace</span><ChevronRight size={13} /><span>My day</span></div><div className="topbar-right"><span className="local-badge"><span /> Local & private</span><button className="icon-button" aria-label="Open connections" onClick={() => setConnections(true)}><Settings2 size={18} /></button></div></header>
      <div className="workspace">
        <div className="page-heading"><div><div className="eyebrow">A LITTLE AHEAD, SO YOU DON’T HAVE TO BE</div><h1>{phaseTitles[state.phase]}</h1><p>Your schedule, gently kept in sync with real life.</p></div><span className="date-badge"><CalendarDays size={16} /> Lunch-overrun scenario</span></div>

        <section className="demo-bar" aria-label="Demo controls"><div className="demo-label"><span className="replay-dot" /><strong>Scenario replay</strong><span className="desktop-only">Seeded calendar & location</span></div><div className="demo-actions"><div className="mode-toggle" role="group" aria-label="Message delivery mode"><button className={!isLive ? 'selected' : ''} disabled={!!busy} onClick={() => void changeMode('replay')}>Simulated WhatsApp</button><button className={isLive ? 'selected live' : ''} disabled={!!busy} onClick={() => void changeMode('live')}>WhatsApp live</button></div><button className="icon-button" title="Reset scenario" aria-label="Reset scenario" disabled={!!busy || (isLive && ['waiting', 'attention', 'uncertain'].includes(state.phase))} onClick={() => void act('reset', '/api/replay/reset', { mode: state.mode })}><RotateCcw size={16} /></button></div></section>
        {(error || offline || state.error || state.telegramNotificationError) && <div className="error-banner" role="alert"><CircleHelp size={18} /><span>{error || (offline ? 'Connection lost. Actions may be delayed; check that the local server is running.' : state.error || state.telegramNotificationError)}</span>{error && <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button>}</div>}

        <div className="main-grid">
          <div className="left-column">
            <section className="card schedule-card"><div className="section-heading"><div><span className="section-icon"><CalendarDays size={18} /></span><h2>Your afternoon</h2></div><span className="tiny-label">2 EVENTS · DEMO</span></div>
              <div className="schedule-row"><div className="schedule-time">12:00<span>1:00 pm</span></div><div className="schedule-line"><span /></div><div className="event event-lunch"><div className="event-icon"><Coffee size={19} /></div><div><h3>Lunch with Professor Lee</h3><p>The Corner Café · In person</p></div><span className={`pill ${state.clock === '13:15' ? 'coral' : 'neutral'}`}>{state.clock === '13:15' ? '+15 min' : 'Just ended'}</span></div></div>
              <div className="now-line"><span>NOW</span><i /><strong>{timeLabel(state.clock)} pm</strong></div>
              <div className="schedule-row"><div className="schedule-time">1:30<span>2:00 pm</span></div><div className="schedule-line next"><span /></div><div className="event event-meeting"><div className="event-icon"><Users size={19} /></div><div><h3>Project catch-up</h3><p>{isLive && p ? p.people.map(person => person.name.split(' ')[0]).join(' & ') : 'Alex & Sam'} · Office</p></div><span className={`pill ${state.phase === 'agreed' ? 'green' : 'neutral'}`}>{state.phase === 'agreed' ? `${timeLabel(p!.time)} agreed` : '30 min'}</span></div></div>
              {state.phase === 'agreed' && <p className="calendar-note"><CheckCheck size={14} /> New time agreed in chat. Calendar invite still needs updating.</p>}
            </section>

            <section className="card evidence-card"><div className="section-heading"><div><span className="section-icon"><Navigation size={18} /></span><h2>The space between meetings</h2></div><span className="tiny-label">REPLAYED SIGNALS</span></div><RouteMap />
              <div className="evidence-stats"><div><span>Time at lunch</span><strong>{state.clock === '13:15' ? '15' : '0'} <small>min over</small></strong></div><div><span>Travel + buffer</span><strong>25 <small>min</small></strong></div><div><span>Until next meeting</span><strong className={state.clock === '13:15' ? 'coral-text' : ''}>{state.clock === '13:15' ? '15' : '30'} <small>min</small></strong></div></div>
              <div className="evidence-footer"><ShieldCheck size={15} /><p>{state.clock === '13:15' ? 'Recent samples stay within 100 m. Estimated arrival: 1:40 pm.' : 'Advance the replay to see what happens when lunch runs over.'}</p></div>
            </section>

            <section className="card activity-card" id="activity"><div className="section-heading"><div><span className="section-icon"><Activity size={18} /></span><h2>Behind the scenes</h2></div><span className="tiny-label">ACTIVITY</span></div>
              <div className="activity-list">{state.activity.length ? state.activity.slice(0, 6).map(item => <div className="activity-item" key={item.id}><span className={`activity-dot ${item.kind}`} /><div><strong>{item.title}</strong><p>{item.detail}</p></div><time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>) : <div className="activity-empty"><span className="quiet-orbit"><Leaf size={20} /></span><div><strong>Quietly keeping an eye on things.</strong><p>Run the scenario to follow each decision here.</p></div></div>}</div>
            </section>
          </div>

          <div className="right-column">
            <section className={`assistant-card ${state.phase === 'agreed' ? 'celebrate' : ''}`}><div className="assistant-heading"><span className="assistant-symbol"><Sparkles size={19} /></span><div><strong>Your next best move</strong><span>DAYFLOW ASSISTANT</span></div><span className={`model-dot ${integrations.llm.available ? 'connected' : ''}`} title={integrations.llm.available ? integrations.llm.model : 'Model not connected'} /></div>
              {state.phase === 'observing' ? <div className="observing-content"><div className="quiet-illustration"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span><Coffee size={34} strokeWidth={1.4} /></span><i className="floating-leaf"><Leaf size={16} /></i></div><span className="pill green">Watching for the right moment</span><h2>Good conversations<br />don’t watch the clock.</h2><p>When lunch runs over, I’ll spot the clash and help coordinate what comes next.</p><button className="button primary full" disabled={!!busy} onClick={() => ready ? void act('advance', '/api/replay/advance') : setConnections(true)}>{busy === 'advance' ? <LoaderCircle size={17} className="spin" /> : <Play size={16} />} {ready ? 'Advance to 1:15 pm' : 'Connect WhatsApp to continue'}<ArrowRight size={16} /></button><small className="helper">15 minutes pass in a moment. All sensor inputs are replayed.</small></div>
              : state.phase === 'preparing' ? <div className="preparing"><LoaderCircle size={35} className="spin" /><h2>Making a little room…</h2><p>Checking the destination and preparing your proposal.</p></div>
              : p ? <div className="proposal-content">
                <span className={`pill ${state.phase === 'agreed' ? 'green' : state.phase === 'attention' || state.phase === 'uncertain' ? 'coral' : 'neutral'}`}>{({ approval: 'Your approval needed', sending: 'Sending your proposal', waiting: 'Waiting for replies', agreed: 'Everyone agreed', attention: 'A reply needs attention', dismissed: 'Monitoring paused', uncertain: 'Delivery unconfirmed' } as Record<string, string>)[state.phase]}</span>
                <h2>{state.phase === 'agreed' ? 'A little breathing room.' : state.phase === 'attention' ? 'Let’s find a time that works.' : state.phase === 'dismissed' ? 'We’ll leave it with you.' : 'Lunch is running a little long.'}</h2>
                <p>{state.phase === 'agreed' ? 'Your colleagues are on board. You can get back to the conversation.' : state.phase === 'attention' ? 'Read the response below. A new time will be sent only after you approve it.' : 'You’re still at the café. With travel time, you’re likely to arrive 10 minutes late.'}</p>
                <div className="time-change"><div><span>FROM</span><strong>1:30 <small>pm</small></strong></div><span className="time-arrow"><ArrowRight size={20} /></span><div><span>{state.phase === 'agreed' ? 'AGREED' : 'PROPOSED'}</span><strong>{timeLabel(p.time)} <small>pm</small></strong></div><span className="duration-tag">30 min</span></div>
                <div className="message-preview"><div><span className="whatsapp-logo"><MessageCircle size={13} /></span><strong>{p.destinationName}</strong><span>{isLive ? 'WhatsApp' : 'Replay'}</span></div><p>{p.text.split('\n\n')[0]}</p><small>Reply reference: {p.code}</small></div>
                <div className="proposal-meta"><Users size={14} /><span>{p.people.map(person => `${person.name}${isLive ? ' (' + person.id + ')' : ''}`).join(', ')}</span></div>
                {state.phase === 'approval' && <>
                  {editing && <form className="time-editor" onSubmit={async event => { event.preventDefault(); if (await act('prepare', '/api/proposal/prepare', { time: newTime })) setEditing(false); }}><label htmlFor="new-time">New meeting time</label><div><input id="new-time" type="time" value={newTime} min="13:40" max="22:30" onChange={e => setNewTime(e.target.value)} required /><button className="button secondary" disabled={!!busy}>Prepare proposal</button></div></form>}
                  <button className="button primary full" disabled={!!busy || !!expired} onClick={() => void act('approve', '/api/proposal/approve', { id: p.id })}>{busy === 'approve' ? <LoaderCircle size={17} className="spin" /> : <Check size={18} />}{expired ? 'Approval expired' : isLive ? 'Approve & send to WhatsApp' : 'Approve replay proposal'}<ArrowRight size={16} /></button>
                  <div className="secondary-actions"><button disabled={!!busy} onClick={() => { setNewTime(p.time); setEditing(!editing); }}>Choose another time</button><span>·</span><button disabled={!!busy} onClick={() => void act('dismiss', '/api/proposal/dismiss', { id: p.id })}>Dismiss</button></div>
                  {expired && <button className="text-button full" disabled={!!busy} onClick={() => void act('prepare', '/api/proposal/prepare', { time: p.time })}>Prepare a fresh proposal</button>}
                  <button className="phone-action" disabled={!!busy} onClick={() => integrations.telegram.paired ? void act('notify', '/api/proposal/notify') : setConnections(true)}><Bell size={15} />{integrations.telegram.paired ? 'Send this approval to my phone' : 'Connect Telegram for phone approval'}<ArrowUpRight size={14} /></button>
                </>}
                {state.phase === 'sending' && <div className="sending-status"><LoaderCircle size={20} className="spin" /> Sending the proposal you approved…</div>}
                {['waiting', 'agreed'].includes(state.phase) && <div className="approved-status"><CheckCheck size={18} /><span>{state.phase === 'agreed' ? 'Agreement recorded' : isLive ? 'Submitted to WhatsApp with your approval' : 'Replay proposal approved'}</span></div>}
                {['attention', 'waiting', 'agreed'].includes(state.phase) && <details className="repropose"><summary>Propose a different time</summary><form onSubmit={event => { event.preventDefault(); void act('prepare', '/api/proposal/prepare', { time: newTime }); }}><label htmlFor="repropose-time">New time (requires a fresh approval)</label><div><input id="repropose-time" type="time" value={newTime} min="13:40" max="22:30" onChange={e => setNewTime(e.target.value)} /><button className="button secondary" disabled={!!busy}>Prepare</button></div></form></details>}
                {state.phase === 'dismissed' && <button className="button primary full" disabled={!!busy} onClick={() => void act('reset', '/api/replay/reset', { mode: state.mode })}><RotateCcw size={16} /> Run another scenario</button>}
                {['waiting', 'attention', 'agreed', 'uncertain'].includes(state.phase) && <button className="text-button full finish-button" disabled={!!busy} onClick={() => void act('finish', '/api/proposal/finish')}>Finish monitoring this conversation</button>}
                <div className="ai-disclosure"><Sparkles size={12} />{p.ai ? `Drafted locally · ${integrations.llm.model}` : 'Template draft · local model unavailable'}</div>
              </div> : null}
            </section>

            {p && running && <section className="card responses-card"><div className="section-heading"><div><span className="section-icon"><MessageCircle size={18} /></span><h2>The conversation</h2></div><span className="pill green">{accepted}/{p.people.length} agreed</span></div><div className="response-list">{p.people.map(person => <ResponseRow person={person} key={person.id} />)}</div><p className="responses-note">{isLive ? `Replies with ${p.code} or a direct quote arrive through your secure WhatsApp connection.` : 'These coworkers and replies are part of the scenario replay.'} Silence is never treated as agreement.</p>
              {!isLive && <form className="reply-form" onSubmit={event => { event.preventDefault(); void act('reply', '/api/replay/reply', { personId: replyPerson, text: replyText }); }}><label htmlFor="reply-person">Try a coworker’s reply <span>SIMULATED</span></label><select id="reply-person" value={replyPerson} onChange={e => setReplyPerson(e.target.value)}>{p.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><div><input aria-label="Coworker reply" value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Could we do 2:15 instead?" required maxLength={2000} /><button className="button primary" aria-label="Submit simulated reply" disabled={!!busy}>{busy === 'reply' ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}</button></div><div className="quick-replies"><button type="button" onClick={() => setReplyText('Yes')}>Accept</button><button type="button" onClick={() => setReplyText('Could we do 2:15 pm instead?')}>Suggest 2:15</button><button type="button" onClick={() => setReplyText('Maybe, let me check first.')}>Unsure</button></div></form>}
            </section>}
            <div className="trust-note"><ShieldCheck size={17} /><p><strong>Your day. Your call.</strong> Every new time needs your approval. Calendar updates are manual in this demo.</p></div>
          </div>
        </div>
        <footer className="workspace-footer"><Brand small /><span>Less coordinating. More being here.</span><span><span className={`connection-dot ${integrations.llm.available ? 'connected' : ''}`} />{integrations.llm.available ? 'Open model running locally' : 'Rules-only fallback available'}</span></footer>
      </div>
    </main>
    {connections && <Connections snapshot={snapshot} refresh={refresh} close={() => setConnections(false)} />}
  </div>;
}

function ResponseRow({ person }: { person: Person }) {
  return <div className="response-row"><span className={`avatar ${person.id === 'alex' ? 'peach' : 'sage'}`}>{person.name.split(' ').map(s => s[0]).slice(0, 2).join('')}</span><div><div className="response-name"><strong>{person.name}</strong><span className={`reply-status ${person.status}`}>{person.status === 'accepted' && <Check size={12} />}{statusLabel[person.status]}</span></div><p>{person.text ? `“${person.text}”` : 'No response yet'}</p>{person.delivery && <span className={`delivery-status ${person.delivery}`}>{({ not_sent: 'Not sent', sending: 'Sending…', queued: 'Queued by Twilio', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Delivery failed', uncertain: 'Delivery unconfirmed' } as Record<string, string>)[person.delivery]}{person.deliveryError ? ` · ${person.deliveryError}` : ''}</span>}{person.proposedTime && <span className="counter-time">Suggested {timeLabel(person.proposedTime)} {Number(person.proposedTime.split(':')[0]) >= 12 ? 'pm' : 'am'}</span>}</div></div>;
}

function Connections({ snapshot, refresh, close }: { snapshot: Snapshot; refresh: () => Promise<void>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({
    twilioAccountSid: snapshot.settings.twilioAccountSid, twilioAuthToken: '',
    whatsappFrom: snapshot.settings.whatsappFrom, whatsappSandboxCode: snapshot.settings.whatsappSandboxCode,
    whatsappWebhookBaseUrl: snapshot.settings.whatsappWebhookBaseUrl,
    telegramToken: '', ollamaUrl: snapshot.settings.ollamaUrl, ollamaModel: snapshot.settings.ollamaModel,
  });
  const [people, setPeople] = useState(snapshot.settings.whatsappRecipients.length ? snapshot.settings.whatsappRecipients : [{ name: '', phone: '' }]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const i = snapshot.integrations;
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { setForm(f => ({ ...f, whatsappWebhookBaseUrl: snapshot.settings.whatsappWebhookBaseUrl })); }, [snapshot.settings.whatsappWebhookBaseUrl]);
  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name); setError(''); setMessage('');
    try { await action(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };
  const save = async () => {
    await request('/api/settings', { ...form, whatsappRecipients: people.filter(p => p.name.trim() || p.phone.trim()).map(p => ({ name: p.name.trim(), phone: p.phone.replace(/[\s()-]/g, '') })) });
    setForm(f => ({ ...f, telegramToken: '', twilioAuthToken: '' }));
  };
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value.trim() }) });
  const joinCode = form.whatsappSandboxCode.replace(/^join\s+/i, '');
  const joinLink = `https://wa.me/${form.whatsappFrom.replace(/\D/g, '')}?text=${encodeURIComponent('join ' + joinCode)}`;

  return <dialog ref={dialog} className="connections-dialog" onCancel={close} onClick={event => { if (event.target === dialog.current) close(); }} aria-labelledby="connections-title"><div className="dialog-header"><div><span className="eyebrow">LET’S GET CONNECTED</span><h2 id="connections-title">Your tools, working together.</h2><p>WhatsApp talks to your coworkers. Telegram keeps you in the loop.</p></div><button className="icon-button" onClick={close} aria-label="Close connections"><X size={21} /></button></div><div className="dialog-body">
    {(error || message) && <div className={error ? 'error-banner' : 'success-banner'} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <section className="setup-section"><div className="setup-heading"><span className="integration-icon whatsapp-logo"><MessageCircle size={24} /></span><div><h3>WhatsApp <span className="required-tag">VIA TWILIO</span></h3><p>Individual messages to your coworkers, after your approval.</p></div><span className={`pill ${i.whatsapp.ready ? 'green' : 'neutral'}`}>{i.whatsapp.ready ? 'Ready' : i.whatsapp.connected ? 'Finish setup' : 'Not connected'}</span></div>
      <details className="setup-instructions" open={!i.whatsapp.configured}><summary>1. Create a WhatsApp testing environment</summary><ol><li>Open <a href="https://console.twilio.com/" target="_blank" rel="noreferrer">Twilio Console <ExternalLink size={12} /></a> and create an account.</li><li>In the legacy console, open <strong>Messaging → Try it out → Send a WhatsApp message</strong> and activate the Sandbox. In the newer trial console, look for <strong>Try out WhatsApp</strong>.</li><li>Copy your <strong>Account SID</strong> and <strong>Auth Token</strong> from the account dashboard. Copy the WhatsApp test sender and join code from the testing screen.</li></ol><p>This demo sends from Twilio’s test number to individual contacts. Coworkers join your testing environment; no Microsoft account or existing WhatsApp group is needed. Twilio trial limits or messaging charges can apply.</p></details>
      <div className="form-grid"><label>Twilio Account SID<input {...field('twilioAccountSid')} placeholder="AC followed by 32 characters" autoComplete="off" /></label><label>Twilio Auth Token<input type="password" {...field('twilioAuthToken')} placeholder={i.whatsapp.configured ? 'Saved — leave blank to keep it' : 'From your Twilio account dashboard'} autoComplete="new-password" /></label><label>WhatsApp test sender<input {...field('whatsappFrom')} placeholder="+14155238886" autoComplete="off" /></label><label>Sandbox join code (optional)<input {...field('whatsappSandboxCode')} placeholder="e.g. join example-code" autoComplete="off" /></label></div>
      <button className="button secondary" disabled={!!busy} onClick={() => void run('whatsapp', async () => { await save(); await request('/api/whatsapp/connect', {}); setMessage('Twilio credentials verified. Next: add coworkers, start the reply connection, and have them send hello.'); })}>{busy === 'whatsapp' ? <LoaderCircle size={16} className="spin" /> : <Plug size={16} />}Save & verify Twilio</button>
      {i.whatsapp.error && <p className="inline-error">{i.whatsapp.error}</p>}

      <div className="setup-step"><h4>2. Add your demo coworkers</h4><p>Enter international phone numbers, such as +852 followed by the number. Up to five coworkers. Each receives a separate proposal.</p>
        {people.map((person, index) => <div className="recipient-editor" key={index}><label>Name<input aria-label={`Coworker ${index + 1} name`} value={person.name} placeholder="Alex" onChange={event => setPeople(people.map((p, n) => n === index ? { ...p, name: event.target.value } : p))} /></label><label>WhatsApp number<input aria-label={`Coworker ${index + 1} phone`} value={person.phone} placeholder="+85212345678" onChange={event => setPeople(people.map((p, n) => n === index ? { ...p, phone: event.target.value } : p))} /></label><button className="icon-button" aria-label={`Remove coworker ${index + 1}`} onClick={() => setPeople(people.filter((_, n) => n !== index))}><X size={15} /></button></div>)}
        <div className="setup-buttons"><button className="text-button" disabled={people.length >= 5} onClick={() => setPeople([...people, { name: '', phone: '' }])}>+ Add coworker</button><button className="button secondary" disabled={!!busy} onClick={() => void run('recipients', async () => { await save(); setMessage('Coworkers saved. Start the reply connection and ask each one to send hello.'); })}>Save coworkers</button></div>
      </div>

      <div className="setup-step"><h4>3. Connect incoming replies</h4><p>Start a temporary connection, then paste the URL below into Twilio’s <strong>When a message comes in</strong> field and choose <strong>POST</strong>. Only signed WhatsApp webhooks are exposed; your dashboard stays local.</p><button className="button secondary" disabled={!!busy || i.whatsapp.tunnel.running} onClick={() => void run('tunnel', async () => { await save(); await request('/api/whatsapp/tunnel/start', {}); })}>{i.whatsapp.tunnel.running && !i.whatsapp.tunnel.url ? <LoaderCircle size={16} className="spin" /> : <Plug size={16} />}{i.whatsapp.tunnel.running ? 'Reply connection running' : 'Start reply connection'}</button>
        {i.whatsapp.inboundUrl && <div className="webhook-url"><label>Twilio “When a message comes in” URL<input readOnly value={i.whatsapp.inboundUrl} /></label><button className="icon-button" aria-label="Copy incoming webhook URL" onClick={() => void run('copy', async () => { await navigator.clipboard.writeText(i.whatsapp.inboundUrl); setMessage('Incoming webhook URL copied. Paste it in Twilio and save with POST.'); })}><Copy size={17} /></button></div>}
        <p className="setup-note">Keep Dayflow running. If you restart the reply connection, its URL changes: paste the new URL in Twilio and save again. Delivery callbacks are attached automatically to outgoing messages.</p>
        {i.whatsapp.tunnel.error && <p className="inline-error">{i.whatsapp.tunnel.error}</p>}
        <details className="setup-instructions advanced-webhook"><summary>Use an existing public webhook connection</summary><label>Public HTTPS base URL<input {...field('whatsappWebhookBaseUrl')} placeholder="https://your-webhook-host.example" /></label><p>Forward this host to the webhook-only listener on port 4319. Then save with the button above.</p></details>
      </div>

      <div className="setup-step"><h4>4. Have coworkers join and say hello</h4><p>Each coworker must send Twilio’s <strong>join code</strong> to the test number. After the webhook URL is saved, ask them to send <strong>hello</strong> as a separate message. Dayflow will show each person as ready below.</p>
        {joinCode && <a className="button secondary" href={joinLink} target="_blank" rel="noreferrer">Open sandbox join message <ArrowUpRight size={15} /></a>}
        <div className="recipient-readiness">{i.whatsapp.recipients.map(person => <div key={person.phone}><div><strong>{person.name}</strong><span>{person.phone}</span></div><span className={`pill ${person.windowOpen ? 'green' : 'neutral'}`}>{person.windowOpen ? 'Ready · hello received' : 'Waiting for hello'}</span></div>)}</div>
        <p className="setup-note">A message from each coworker opens a 24-hour free-form messaging window. Ask them to send hello again before a later demo. A sandbox membership expires after three days, so they may need to rejoin.</p>
      </div>
    </section>
    <section className="setup-section"><div className="setup-heading"><span className="integration-icon telegram-icon"><Send size={23} /></span><div><h3>Telegram</h3><p>Approve proposals and receive updates on your phone.</p></div><span className={`pill ${i.telegram.paired ? 'green' : 'neutral'}`}>{i.telegram.paired ? 'Paired' : 'Not paired'}</span></div><details className="setup-instructions" open={!i.telegram.configured}><summary>Create your bot · about 2 minutes</summary><ol><li>Open Telegram and find the verified <strong>@BotFather</strong>.</li><li>Send <code>/newbot</code>, choose a name and a username ending in <code>bot</code>.</li><li>Paste the bot token below, then click <strong>Save & pair Telegram</strong>.</li><li>Open the pairing link on your phone and tap <strong>Start</strong>. It connects this bot to you.</li></ol></details><label>Bot token<input type="password" {...field('telegramToken')} placeholder={i.telegram.configured ? 'Saved — leave blank to keep it' : '123456789:your-bot-token'} autoComplete="new-password" /></label><button className="button secondary" disabled={!!busy} onClick={() => void run('telegram', async () => { await save(); await request('/api/telegram/connect', {}); })}>{busy === 'telegram' ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{i.telegram.paired ? 'Check Telegram connection' : 'Save & pair Telegram'}</button>
      {i.telegram.username && i.telegram.pairingCode && <div className="auth-card"><p>On your phone, open this link and tap Start. Pairing expires in 10 minutes.</p><a className="button primary" href={`https://t.me/${i.telegram.username}?start=${i.telegram.pairingCode}`} target="_blank" rel="noreferrer">Pair @{i.telegram.username} <ArrowUpRight size={15} /></a><p className="pair-command">Or send <code>/start {i.telegram.pairingCode}</code> directly to your bot.</p></div>}
      {i.telegram.paired && <p className="connected-note"><CheckCheck size={15} /> Your phone is paired. New proposals will include an approval button.</p>}{i.telegram.error && <p className="inline-error">{i.telegram.error}</p>}
    </section>

    <section className="setup-section"><div className="setup-heading"><span className="integration-icon model-icon"><Sparkles size={22} /></span><div><h3>Open model · Ollama</h3><p>Your drafts and reply interpretation run on this computer.</p></div><span className={`pill ${i.llm.available ? 'green' : 'neutral'}`}>{i.llm.available ? 'Ready' : 'Not running'}</span></div><div className="form-grid"><label>Local Ollama URL<input {...field('ollamaUrl')} /></label><label>Model name<input {...field('ollamaModel')} /></label></div><div className="command-block"><code>ollama serve</code><code>ollama pull {form.ollamaModel}</code></div><p className="setup-note">Run the server and model download in separate terminals if they aren’t running yet. The first response may take a moment while the model loads.</p><button className="button secondary" disabled={!!busy} onClick={() => void run('llm', async () => { await save(); await request('/api/llm/check', {}); })}>{busy === 'llm' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Save & check model</button>{i.llm.error && <p className="inline-error">{i.llm.error}</p>}</section>

    <section className="demo-guide"><span className="eyebrow">YOUR 90-SECOND DEMO</span><h3>One tap. The rest gets handled.</h3><ol><li>Finish WhatsApp setup above and pair Telegram.</li><li>Select <strong>WhatsApp live</strong> on the dashboard.</li><li>Press <strong>Advance to 1:15 pm</strong> to replay the location evidence.</li><li>Approve the exact proposal on Telegram.</li><li>Have coworkers quote/reply to their WhatsApp proposal, or include its reference: <code>#DF-ABC123 yes</code>.</li><li>Watch Dayflow record the replies and report back to your phone.</li></ol><p>The calendar, location samples, and travel estimate are seeded demo inputs. Live mode uses real WhatsApp messages and real replies. This app does not update calendar invitations.</p></section>
    </div><div className="dialog-footer"><span><ShieldCheck size={14} /> Credentials stay on this computer.</span><button className="button primary" onClick={close}>Back to my day <ArrowRight size={16} /></button></div></dialog>;
}
