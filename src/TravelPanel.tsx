import { useCallback, useEffect, useState } from 'react';
import { Bell, MapPin, Navigation, RefreshCw, Video } from 'lucide-react';
import { calendarRange, calendarTime, type CalendarSnapshot } from '../shared/calendar';
import { safeJoinUrl, type TravelSnapshot } from '../shared/travel';
import { request } from './api';

export function TravelPanel({ calendar, now, telegramReady, onPlan }: { calendar: CalendarSnapshot; now: number; telegramReady: boolean; onPlan: () => void }) {
  const [data, setData] = useState<TravelSnapshot | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [address, setAddress] = useState('');
  const refresh = useCallback(async () => { try { setData(await request<TravelSnapshot>('/api/travel/state')); } catch { /* The main workspace reports an offline server. */ } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  const act = async (action: string, body = {}, check = false) => {
    if (busy) return; setBusy(action); setError('');
    try { await request(`/api/travel/${action}`, body); if (check) await request('/api/travel/check', {}); if (action === 'propose') onPlan(); }
    catch (e) { setError((e as Error).message); } finally { await refresh(); setBusy(''); }
  };
  const locate = () => {
    if (!navigator.geolocation) { setError('Location is unavailable in this browser. Enter your current address.'); return; }
    setBusy('location'); setError('');
    navigator.geolocation.getCurrentPosition(position => {
      void (async () => {
        try { await request('/api/travel/settings', { origin: { source: 'browser', label: 'Browser location', coordinates: { latitude: position.coords.latitude, longitude: position.coords.longitude }, accuracy: position.coords.accuracy } }); await request('/api/travel/check', {}); }
        catch (e) { setError((e as Error).message); } finally { await refresh(); setBusy(''); }
      })();
    }, () => { setError('Location permission was denied or your position is unavailable. Allow location for this browser, or enter your current address.'); setBusy(''); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  };
  const timezone = calendar.day?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const upcomingOnline = calendar.day?.events.filter(e => e.online && !e.allDay && e.busy && e.end > now) || [];
  const estimate = data?.estimate;
  const event = estimate && calendar.day?.events.find(e => e.id === estimate.event.id);
  const fresh = !!estimate && !!event && event.start === estimate.event.start && event.modified === estimate.event.modified && event.start > now && now - estimate.checkedAt <= 2 * 60000 && calendar.connected && !calendar.paused && now - (data?.settings.origin?.updatedAt || 0) <= 30 * 60000;
  const canMove = fresh && event?.editable && calendar.rules[event.id]?.flexible;
  const late = fresh && estimate && now + (estimate.travelMinutes + estimate.bufferMinutes) * 60000 > estimate.event.start;
  return <section className="card travel-panel" aria-label="Real travel and meeting reminders">
    <div className="section-heading"><div><span className="section-icon"><Navigation size={18}/></span><h2>Travel & meeting reminders</h2></div><span className="pill neutral">Apple Maps</span></div>
    <p>Real routes to the next in-person event. Online meetings get a join link and a reminder 10 minutes before they start.</p>
    {data ? <>
      <div className="travel-controls"><form onSubmit={e => { e.preventDefault(); void act('settings', { origin: { source: 'address', label: address, address } }, true); }}><label>Where are you now?<input placeholder="Enter your full current address" value={address} onChange={e => setAddress(e.target.value)} maxLength={300}/></label><button className="button secondary" disabled={!!busy || data.checking || address.trim().length < 3 || !calendar.connected}>Use this address</button><button className="button secondary" type="button" disabled={!!busy || data.checking || !calendar.connected} onClick={locate}><MapPin size={15}/>Use my location</button></form>
      <div className="travel-options"><label>Travel mode<select value={data.settings.mode} disabled={!!busy || data.checking} onChange={e => void act('settings', { mode: e.target.value }, !!data.settings.origin)}><option value="driving">Driving / taxi</option><option value="walking">Walking</option></select></label><label>Extra buffer (minutes)<input type="number" min={0} max={60} value={data.settings.bufferMinutes} disabled={!!busy || data.checking} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 60) void act('settings', { bufferMinutes: n }, !!data.settings.origin); }}/></label></div></div>
      <p className="calendar-muted">{data.settings.origin ? <>From {data.settings.origin.label} · updated {calendarTime(data.settings.origin.updatedAt, timezone)}{data.settings.origin.accuracy ? ` · accuracy ±${Math.round(data.settings.origin.accuracy)} m` : ''}. </> : ''}Location is a snapshot; update it when you move or after 30 minutes. Driving estimates do not include waiting for a taxi. For MTR or buses, open Apple Maps and choose transit.</p>
      <label className="calendar-toggle"><input type="checkbox" checked={data.settings.enabled} disabled={!!busy || !calendar.connected || !telegramReady} onChange={e => void act('settings', { enabled: e.target.checked })}/><span><strong>Remind me on Telegram</strong><small>Late-arrival warnings and online meeting links, while this Mac and DayMade are running. Friends are contacted only after you approve a proposal.</small></span><Bell size={18}/></label>
      <div className="calendar-actions"><button className="button secondary" disabled={!!busy || data.checking || !calendar.connected} onClick={() => void act('check')}><RefreshCw size={15}/>{busy || data.checking ? 'Checking…' : 'Refresh travel'}</button>{(data.settings.origin || data.settings.enabled) && <button className="button secondary" disabled={!!busy} onClick={() => void act('disconnect')}>Disconnect travel & reminders</button>}</div>
      {(error || data.error || data.notificationError) && <div className="error-banner" role="alert">{error || data.error || data.notificationError}</div>}
      <p className="calendar-muted" role="status">{data.status}</p>
      {estimate && <div className={`travel-result ${late ? 'travel-late' : ''}`}>
        <div className="section-heading"><div><h3>{estimate.event.title}</h3></div><span className={`pill ${fresh ? late ? 'neutral' : 'green' : 'neutral'}`}>{fresh ? late ? 'Likely late' : 'Time to get there' : 'Estimate expired · refresh'}</span></div>
        <p><MapPin size={14}/> {estimate.event.location || 'Venue coordinates from Calendar'} · {calendarRange(estimate.event.start, estimate.event.end, timezone)}</p>
        {(estimate.originName || estimate.destinationName) && <p className="calendar-muted">Maps matched: {estimate.originName || data.settings.origin?.label} → {estimate.destinationName || estimate.event.location}. Check these places on the map.</p>}
        <div className="travel-metrics"><div><strong>{estimate.travelMinutes} min</strong><small>{data.settings.mode} · {(estimate.meters / 1000).toFixed(1)} km</small></div><span>+</span><div><strong>{estimate.bufferMinutes} min</strong><small>your extra buffer</small></div><span>=</span><div><strong>{estimate.travelMinutes + estimate.bufferMinutes} min</strong><small>travel + buffer</small></div></div>
        <p>{fresh ? <>Leave by <strong>{calendarTime(estimate.leaveBy, timezone)}</strong>. Ready around <strong>{calendarTime(now + (estimate.travelMinutes + estimate.bufferMinutes) * 60000, timezone)}</strong> if you leave now.{late ? ' You may not reach this meeting on time.' : ''}</> : 'Refresh before using this estimate to plan your departure.'}</p>
        {estimate.mapImage && <a href={estimate.mapsUrl} target="_blank" rel="noreferrer"><img className="real-route-map" src={estimate.mapImage} alt={`Apple Maps route from your starting point to ${estimate.event.location || estimate.event.title}`}/></a>}
        <p className="calendar-muted">Apple Maps estimate checked {calendarTime(estimate.checkedAt, timezone)}. Green marker: start. Red marker: venue. Actual conditions may change.</p>
        <div className="calendar-actions"><a className="button secondary" href={estimate.mapsUrl} target="_blank" rel="noreferrer">Open route in Apple Maps ↗</a>{late && <button className="button primary" disabled={!!busy || data.checking || !canMove} onClick={() => void act('propose', { eventId: estimate.event.id })}>Find a later time & review</button>}</div>
        {late && !canMove && <p className="calendar-muted">Enable rescheduling on this event and select its friends below to coordinate a change. Calendar invitations stay fixed.</p>}
      </div>}
    </> : <p className="calendar-muted">Loading travel settings…</p>}
    {upcomingOnline.map(event => <article className="online-meeting" key={event.id}><Video size={20}/><div><strong>{event.title}</strong><p>{calendarRange(event.start, event.end, timezone)} · {event.start <= now ? 'Happening now' : `Starts in ${Math.ceil((event.start - now) / 60000)} min`} · Online, no travel needed</p>{safeJoinUrl(event.joinUrl) ? <a href={safeJoinUrl(event.joinUrl)!} target="_blank" rel="noreferrer">Join online meeting ↗</a> : <p>Add the meeting’s join link in Apple Calendar.</p>}</div></article>)}
  </section>;
}
