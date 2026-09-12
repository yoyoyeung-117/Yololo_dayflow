import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowUpRight, CalendarDays, ChevronRight, CircleHelp, Leaf, LoaderCircle, Plug, Settings2, ShieldCheck } from 'lucide-react';
import type { Snapshot } from '../shared/types';
import { CalendarWorkspace } from './CalendarWorkspace';
import { Connections } from './Connections';
import { request } from './api';

function Brand() {
  return <div className="brand"><span className="brand-mark"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M7 7h8a8 8 0 0 1 0 16H7m0-8h17" /></svg></span><span>DayMade<span className="brand-dot">.</span></span></div>;
}
export function App() {
  const [view, setView] = useState(['demo', 'plan'].includes(new URLSearchParams(window.location.search).get('view') || '') ? 'plan' : 'calendar');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [offline, setOffline] = useState(false);
  const [connections, setConnections] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { try { setSnapshot(await request<Snapshot>('/api/state')); setOffline(false); } catch { setOffline(true); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, [refresh]);
  const navigate = (next: string) => { setView(next); const url = new URL(window.location.href); url.searchParams.set('view', next); window.history.replaceState({}, '', url); };
  if (!snapshot) return <div className="boot"><Brand/><LoaderCircle className="spin"/><p>{offline ? 'Start the server with npm start, then refresh this page.' : 'Opening your day…'}</p></div>;
  const legacy = snapshot.state, activeLegacy = legacy.mode === 'live' && ['approval', 'preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(legacy.phase);
  const stopLegacy = async () => {
    setBusy(true); setError('');
    try { await request(legacy.phase === 'approval' ? '/api/proposal/dismiss' : '/api/proposal/finish', { id: legacy.proposal?.id }); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="app-shell">
    <aside className="sidebar"><Brand/><div className="workspace-label">YOUR PERSONAL COORDINATOR</div>
      <nav aria-label="Main navigation">
        <button className={`nav-item ${view === 'calendar' ? 'active' : ''}`} onClick={() => navigate('calendar')}><CalendarDays size={19}/> My calendar</button>
        <button className={`nav-item ${view === 'plan' ? 'active' : ''}`} onClick={() => navigate('plan')}><CalendarDays size={19}/> Plan my day</button>
        <button className="nav-item" onClick={() => setConnections(true)}><Plug size={19}/> Connections <span className={`connection-dot ${snapshot.integrations.telegram.connected ? 'connected' : ''}`}/></button>
        <button className="nav-item" onClick={() => document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' })}><Activity size={19}/> Activity</button>
      </nav>
      <div className="sidebar-note"><span className="note-icon"><Leaf size={21}/></span><h3>Stay in the moment.</h3><p>I’ll help with what comes next. Review your real day and approve what moves.</p><div><ShieldCheck size={14}/> Your calendar, your choices</div></div>
      <button className="sidebar-help" onClick={() => setConnections(true)}><CircleHelp size={17}/> Setup guide <ArrowUpRight size={15}/></button>
      <div className="profile"><span className="avatar owner">Y</span><div><strong>Yoyo</strong><span>Yololo</span></div><Settings2 size={16}/></div>
    </aside>
    <main><header className="topbar"><div><span className="breadcrumb">Workspace</span><ChevronRight size={13}/><span>{view === 'plan' ? 'Plan my day' : 'My calendar'}</span></div><div className="topbar-right"><span className="local-badge"><span/> Local & private</span><button className="icon-button" aria-label="Open connections" onClick={() => setConnections(true)}><Settings2 size={18}/></button></div></header>
      {(offline || error) && <div className="error-banner" role="alert">{error || 'DayMade is offline. Keep the server running on this Mac.'}</div>}
      {activeLegacy && <section className="card previous-conversation"><h2>Previous conversation</h2><p>This earlier proposal is still being monitored. Stop it before starting a plan from Calendar.</p>{legacy.proposal?.people.map(p => <p key={p.id}><strong>{p.name}</strong>: {p.text || p.status} · {p.delivery}</p>)}<button className="button secondary" disabled={busy || ['preparing', 'sending'].includes(legacy.phase)} onClick={() => void stopLegacy()}>Stop previous conversation</button></section>}
      <CalendarWorkspace key={view} planning={view === 'plan'} snapshot={snapshot} connections={() => setConnections(true)}/>
    </main>
    {connections && <Connections snapshot={snapshot} refresh={refresh} close={() => setConnections(false)}/>}
  </div>;
}
