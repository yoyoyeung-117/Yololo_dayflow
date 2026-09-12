import { useCallback, useEffect, useState } from 'react';
import type { RequestSnapshot } from '../shared/requests';
import { calendarRange } from '../shared/calendar';
import { request } from './api';

export function RequestsInbox({ ready }: { ready: boolean }) {
  const [data, setData] = useState<RequestSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [times, setTimes] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => { try { setData(await request<RequestSnapshot>('/api/requests/state')); } catch { setError('Could not load teammate requests. Check that DayMade is running.'); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => clearInterval(timer); }, [refresh]);
  const act = async (endpoint: string, body: object) => {
    if (busy) return; setBusy(true); setError('');
    try { await request(`/api/requests/${endpoint}`, body); } catch (e) { setError((e as Error).message); }
    finally { await refresh(); setBusy(false); }
  };
  if (!data) return error ? <div role="alert" className="error-banner">{error}</div> : null;
  return <section className="card teammate-inbox" aria-labelledby="requests-title">
    <div className="section-heading"><div><h2 id="requests-title">Requests from your friends</h2></div><span className={`pill ${data.enabled && ready ? 'green' : 'neutral'}`}>{!data.enabled ? 'Paused' : ready ? 'Listening' : 'Needs connections'}</span></div>
    <p>Your friends can start a conversation too. Post a new message in the connected Discord channel or Zoom Team Chat: <strong>“Can we move Coffee from 17:00 to 17:30?”</strong></p>
    <label className="calendar-toggle"><input type="checkbox" checked={data.enabled} disabled={busy} onChange={e => void act('monitor', { enabled: e.target.checked })}/><span><strong>Handle teammate rescheduling requests</strong><small>For today’s flexible events linked to that friend. Free time → ask you on Telegram. Busy time → automatically offer a free alternative with a 10-minute buffer. Save only once everyone agrees.</small></span></label>
    {!ready && <p className="calendar-muted">Connect Calendar, pair Telegram and connect your friends’ messaging platforms. Keep this Mac running.</p>}
    {(error || data.error) && <p role="alert" className="inline-error">{error || data.error}</p>}
    {!data.requests.length && <p className="calendar-muted">Waiting for a new request. Include the meeting title or its original time and a new time today. Use 24-hour times for clarity.</p>}
    {data.requests.slice(0, 12).map(r => <article className="calendar-change" key={r.id}>
      <div className="calendar-event-heading"><h3>{r.sender.name}{r.event ? ` · ${r.event.title}` : ''}</h3><span className="pill neutral">{r.status.replaceAll('_', ' ')}</span></div>
      <p className="teammate-quote">“{r.text}”</p>
      {r.event && <p>{calendarRange(r.event.start, r.event.end, r.timezone!)} → <strong>{r.selectedTime || r.requestedTime}</strong> · {r.day} · {r.timezone}</p>}
      {r.note && <p className="calendar-muted">{r.note}</p>}
      {r.notificationError && <p className="inline-error">{r.notificationError}</p>}
      {r.status === 'awaiting_owner' && <><p className="calendar-muted">Accept once to let DayMade coordinate with the same friends and update Calendar after agreement. You can also answer on Telegram.</p><div className="calendar-actions">
        <button className="button primary" disabled={busy || Date.now() >= r.expiresAt} onClick={() => void act('respond', { id: r.id, choice: 'accept' })}>Accept {r.requestedTime}</button>
        <button className="button secondary" disabled={busy} onClick={() => void act('respond', { id: r.id, choice: 'reject' })}>Decline request</button>
      </div><form className="request-time-form" onSubmit={e => { e.preventDefault(); void act('respond', { id: r.id, choice: 'accept', time: times[r.id] }); }}><label>Another time for {r.event?.title}<input type="text" lang="en-GB" placeholder="HH:mm" title="24-hour time, for example 18:30" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} autoComplete="off" onInvalid={e => e.currentTarget.setCustomValidity('Enter a 24-hour time, for example 18:30.')} onInput={e => e.currentTarget.setCustomValidity('')} required value={times[r.id] || ''} onChange={e => setTimes({ ...times, [r.id]: e.target.value })}/></label><button className="button secondary" disabled={busy || !times[r.id] || Date.now() >= r.expiresAt}>Propose this time</button></form></>}
    </article>)}
  </section>;
}
