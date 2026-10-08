import { useEffect, useRef, useState } from 'react';

// Leave VITE_API_URL empty to use the Vite proxy (/api -> localhost:3001),
// or set it in a frontend .env file, e.g. VITE_API_URL=http://localhost:3001
const API_URL = import.meta.env.VITE_API_URL ?? '';

const judges = [
  { name: 'Victor Vance', role: 'THE BRUTAL VC', type: 'vc', initials: 'VV', quote: '“Cool idea. Where’s the money?”', focus: ['Market size', 'Unit economics', 'Monetization'], photo: 'photo-1560250097-0b93528c311a' },
  { name: 'Dr. Aris Thorne', role: 'THE TECH PURIST', type: 'tech', initials: 'AT', quote: '“Let’s talk about your edge cases.”', focus: ['Architecture', 'Tech stack', 'Scalability'], photo: 'photo-1500648767791-00dcc994a43e' },
  { name: 'Chloe Chen', role: 'THE VIRAL WILDCARD', type: 'wild', initials: 'CC', quote: '“But would the internet care?”', focus: ['Branding', 'Virality', 'Unhinged energy'], photo: 'photo-1534528741775-53994a69daeb' },
];
const presets = ['Uber, but for houseplants', 'An AI that attends your meetings', 'A dating app for your side projects'];

// Only used for the "A taste of the court" preview before the first pitch.
const sampleDebate = [
  { judge: 0, text: 'Another AI wrapper? Tell me why this isn’t a feature that gets shipped next Tuesday.' },
  { judge: 1, text: 'Forget the market. What happens when the model hallucinates? Your entire architecture is a trust fall.' },
  { judge: 2, text: 'Okay, but “a trust fall with a subscription” is actually a great tagline.' },
];

type JudgeId = 'victor' | 'aris' | 'chloe';
type ApiJudge = { id: JudgeId; critique: string; roast: string; score: number; audio: { mimeType: string; base64: string } | null };
type Verdict = { score: number; ruling: string; takeaways: string[] };
type Line = { judge: number; text: string; roast: string; score: number };

const judgeIndex: Record<JudgeId, number> = { victor: 0, aris: 1, chloe: 2 };

// Tiny silent clip, played inside the click handler so browsers (esp. Safari) allow audio later.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
const readingTime = (text: string) => Math.min(7000, 1500 + text.length * 40);

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'mic' ? <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></> : name === 'arrow' ? <><path d="M5 12h14M13 6l6 6-6 6" /></> : name === 'chevron' ? <path d="m7 10 5 5 5-5" /> : name === 'close' ? <path d="m6 6 12 12M18 6 6 18" /> : name === 'sound' ? <><path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></> : <><path d="m7 3 9 9M5 5l4-4M14 14l4-4M11 9l-6 6M3 17l-1 1 3 3 1-1M14 20h8M15 17h6v3" /></>}
  </svg>;
}

function Wave({ active = false }: { active?: boolean }) {
  return <span className={`wave ${active ? 'active' : ''}`} aria-hidden="true">{[4, 9, 15, 7, 19, 12, 6, 14, 8].map((height, index) => <i key={index} style={{ height, animationDelay: `${index * .09}s` }} />)}</span>;
}

// "REJECTED WITH PASSION" -> ["REJECTED", "WITH PASSION"] (matches the two-line stamp design)
function splitRuling(ruling: string) {
  const words = ruling.split(' ');
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

export default function App() {
  const [pitch, setPitch] = useState('');
  const [presetOpen, setPresetOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);   // waiting for the backend
  const [running, setRunning] = useState(false);   // whole session: loading + judges speaking
  const [speaker, setSpeaker] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState('');
  const [sound, setSound] = useState(true);
  const [voiceMessage, setVoiceMessage] = useState('');
  const [recording, setRecording] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const soundRef = useRef(sound);
  const runIdRef = useRef(0);
  const showVerdict = verdict !== null;

  // Muting mid-session cuts the current voice; the debate keeps going as text.
  useEffect(() => {
    soundRef.current = sound;
    if (!sound) stopRef.current?.();
  }, [sound]);

  useEffect(() => () => { runIdRef.current++; stopRef.current?.(); }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [lines, loading, showVerdict, error]);

  function playClip(audio: HTMLAudioElement, src: string) {
    return new Promise<void>(resolve => {
      const done = () => { audio.onended = null; audio.onerror = null; stopRef.current = null; resolve(); };
      stopRef.current = () => { audio.pause(); done(); };
      audio.onended = done;
      audio.onerror = done;
      audio.src = src;
      audio.play().catch(done);
    });
  }

  async function submitPitch() {
    if (!pitch.trim() || running) return;
    const runId = ++runIdRef.current;

    // Unlock audio during the click, before any awaiting.
    const audio = audioRef.current ?? (audioRef.current = new Audio());
    audio.src = SILENT_WAV;
    audio.play().catch(() => {});

    setStarted(true); setRunning(true); setLoading(true); setPresetOpen(false);
    setLines([]); setVerdict(null); setSpeaker(null); setError('');
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);

    try {
      let res: Response;
      try {
        res = await fetch(`${API_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pitchText: pitch.trim() }),
        });
      } catch {
        throw new Error('Couldn’t reach the court. Is the server running on port 3001?');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The court has collapsed. Try again.');
      if (runId !== runIdRef.current) return;
      setLoading(false);

      // Judges speak one at a time: show the line, play the voice, wait for it to end.
      for (const j of data.judges as ApiJudge[]) {
        const idx = judgeIndex[j.id];
        setLines(current => [...current, { judge: idx, text: j.critique, roast: j.roast, score: j.score }]);
        setSpeaker(idx);
        if (soundRef.current && j.audio) await playClip(audio, `data:${j.audio.mimeType};base64,${j.audio.base64}`);
        else await wait(readingTime(j.critique));
        if (runId !== runIdRef.current) return;
        setSpeaker(null);
        await wait(600);
        if (runId !== runIdRef.current) return;
      }

      // All judges done -> reveal the verdict.
      setVerdict(data.verdict as Verdict);
    } catch (err) {
      if (runId === runIdRef.current) setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      if (runId === runIdRef.current) { setRunning(false); setLoading(false); setSpeaker(null); }
    }
  }

  function voiceInput() {
    const browser = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
    const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Recognition) { setVoiceMessage('Voice input isn’t supported here. Type your pitch instead.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.onresult = (event: any) => { setPitch(event.results[0][0].transcript); setVoiceMessage('Pitch captured. Ready for the court?'); };
    recognition.onerror = () => setVoiceMessage('Microphone unavailable. You can still type your pitch.');
    recognition.onend = () => setRecording(false);
    setRecording(true); setVoiceMessage('Listening… make your case.'); recognition.start();
  }

  function pitchAgain() {
    runIdRef.current++;
    stopRef.current?.();
    setStarted(false); setVerdict(null); setLines([]); setError(''); setPitch('');
    document.querySelector<HTMLInputElement>('.pitch-form input')?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#"><span className="brand-symbol"><Icon name="gavel" size={21} /></span> THE PITCH COURT<span className="beta">BETA</span></a>
      <div className="header-right"><span className="court-status"><span className="status-dot" /> Court is in session</span><button className="text-button" onClick={() => setShowAbout(true)}>How it works <span>↗</span></button></div>
    </header>

    <main>
      <section className="hero">
        <div className="eyebrow"><span /> BIG IDEAS. BRUTALLY HONEST FEEDBACK.</div>
        <h1>The Pitch <em>Court.</em></h1>
        <p className="hero-description">Three AI judges. Zero sugarcoating.<br />Pitch your next big thing. Let the deliberation begin.</p>
        <form className="pitch-form" onSubmit={event => { event.preventDefault(); submitPitch(); }}>
          <button type="button" className={`mic-button ${recording ? 'recording' : ''}`} aria-label="Record your pitch" onClick={voiceInput}><Icon name="mic" /></button>
          <input value={pitch} onChange={event => setPitch(event.target.value)} placeholder="PITCH YO IDEA…" aria-label="Your project pitch" required />
          <div className="preset-container"><button className="preset-button" type="button" aria-expanded={presetOpen} onClick={() => setPresetOpen(!presetOpen)}>Try an idea <Icon name="chevron" size={15} /></button>
            {presetOpen && <div className="preset-menu">{presets.map(preset => <button type="button" key={preset} onClick={() => { setPitch(preset); setPresetOpen(false); }}>{preset}</button>)}</div>}
          </div>
          <button className="submit-button" type="submit" disabled={running} aria-label="Submit pitch"><Icon name="arrow" size={22} /></button>
        </form>
        <p className="input-hint" aria-live="polite">{voiceMessage || <><span>Type it. Say it. Defend it.</span><span className="hint-divider">/</span> Your ego may not survive.</>}</p>
      </section>

      <section className="panel-section">
        <div className="section-heading"><h2><span className="section-number">01 /</span> Meet your jury</h2><span className="section-note">THREE MINDS. THREE VERY DIFFERENT AGENDAS.</span></div>
        <div className="judge-grid">{judges.map((judge, index) => <article className={`judge-card ${judge.type}`} key={judge.name}>
          <div className="judge-topline"><span className="judge-index">JUDGE 0{index + 1}</span><span className="judge-ready"><span />{speaker === index ? 'Speaking' : 'Ready to judge'}</span></div>
          <div className="portrait-wrap"><div className="portrait-ring"><img src={`https://images.unsplash.com/${judge.photo}?w=240&h=240&fit=crop&crop=faces&auto=format`} alt={`${judge.name}, AI judge persona`} /></div><span className="portrait-mark">{index === 0 ? '$' : index === 1 ? '</>' : '✳'}</span></div>
          <div className="judge-info"><span className="archetype">{judge.role}</span><h3>{judge.name}</h3><p className="judge-quote">{judge.quote}</p></div>
          <div className="focus-tags">{judge.focus.map(focus => <span key={focus}>{focus}</span>)}</div>
          <div className="judge-footer"><span><span className="tiny-dot" /> {running ? 'In deliberation' : 'Mic check. Ego check.'}</span><Wave active={speaker === index} /></div>
        </article>)}</div>
      </section>

      <section className="deliberation-section" ref={resultRef}>
        <div className="section-heading"><h2><span className="section-number">02 /</span> The deliberation</h2><span className="example-label"><span className="status-dot" /> {started ? showVerdict ? 'SESSION COMPLETE' : 'LIVE SESSION' : 'A TASTE OF THE COURT'}</span></div>
        <div className="deliberation-grid">
          <article className="transcript chat-window"><div className="window-heading"><span><span className={running ? 'live-dot pulsing' : 'live-dot'} /> {showVerdict ? 'COURT ADJOURNED' : 'THE JURY'}</span><button className={`sound-button ${sound ? 'sound-on' : ''}`} onClick={() => setSound(!sound)} aria-label={sound ? 'Turn audio off' : 'Turn audio on'}><Icon name="sound" size={17} /><span>Audio {sound ? 'on' : 'off'}</span></button></div>
            <div className="transcript-content chat-history" ref={chatRef} role="log" aria-live="polite">
              {started && <div className="user-message"><span>YOU · THE PITCH</span><p>{pitch}</p></div>}
              {!started && sampleDebate.map((line, index) => <div className={`debate-line ${judges[line.judge].type}`} key={`sample-${index}`}><span className="speaker-initials">{judges[line.judge].initials}</span><div><h4>{judges[line.judge].name}<span>{`00:${String(12 + index * 9).padStart(2, '0')}`}</span></h4><p>{line.text}</p></div></div>)}
              {lines.map((line, index) => <div className={`debate-line ${judges[line.judge].type}`} key={index}><span className="speaker-initials">{judges[line.judge].initials}</span><div><h4>{judges[line.judge].name}<span>{line.score}/100</span></h4><p>{line.text}</p><p><em>“{line.roast}”</em></p></div></div>)}
              {loading && <div className="typing-indicator"><span /><span /><span /> The jury is conferring…</div>}
              {error && <div className="typing-indicator" role="alert">⚠ {error}</div>}
              {verdict && <div className="inline-verdict"><div className="inline-verdict-label"><Icon name="gavel" size={17} /> THE FINAL VERDICT</div><div className="inline-verdict-heading"><h3>{splitRuling(verdict.ruling)[0]}<br />{splitRuling(verdict.ruling)[1]}</h3><div><strong>{verdict.score}</strong><span>/100</span><small>CONSENSUS SCORE</small></div></div><ul>{verdict.takeaways.map((takeaway, index) => <li key={index}>{takeaway}</li>)}</ul><p>Take the roast. Make it better.</p></div>}
            </div>
            <div className="chat-bottom">{showVerdict
              ? <div className="chat-complete"><span>Case closed. Your next idea could change everything.</span><button onClick={pitchAgain}>Pitch again <Icon name="arrow" size={17} /></button></div>
              : <div className="chat-composer-footer"><span>{loading ? 'The jury is conferring… hang tight.' : running ? 'The court is in session. Listen up.' : 'Pitch your idea above to take the stand.'}</span></div>}
            </div>
          </article>
        </div>
        <div className="bottom-note"><span>All rise. Then iterate.</span><p>AI-generated opinions. Real-world ambition. Don’t take it personally.</p></div>
      </section>
    </main>
    <footer><span>© THE PITCH COURT 2026</span><span>BUILT FOR BIG IDEAS & THICK SKIN.</span><span>NO FOUNDERS WERE HARMED. <span className="footer-aside">(PROBABLY.)</span></span></footer>
    {showAbout && <div className="modal-backdrop" onClick={() => setShowAbout(false)}><section role="dialog" aria-modal="true" aria-labelledby="about-title" className="about-modal" onClick={event => event.stopPropagation()}><button className="modal-close" aria-label="Close" onClick={() => setShowAbout(false)}><Icon name="close" /></button><span className="eyebrow">WELCOME TO THE COURT</span><h2 id="about-title">Make your case.</h2><p>1. Type your idea, record a pitch, or try a preset.</p><p>2. Submit with the arrow. Watch our three personalities roast you, out loud.</p><p>3. Get your verdict. Take the roast, refine your idea, and try again.</p><div className="demo-disclaimer">Judges are powered by Groq (Llama) and voiced with ElevenLabs. Opinions are AI-generated and intentionally harsh.</div><button className="about-cta" onClick={() => setShowAbout(false)}>Court is in session <Icon name="arrow" /></button></section></div>}
  </div>;
}
