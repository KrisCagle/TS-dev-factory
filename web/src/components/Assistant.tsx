import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFactory } from '../state';
import { useUI } from '../ui';

/**
 * The assistant dock: talk to the factory. Free, no accounts:
 *  - listening uses the browser's built-in speech recognition (Safari runs it on-device; Chrome uses
 *    Google's free service), or a local Whisper command you set in Settings → Voice;
 *  - replies are spoken with your Mac's own voices (speechSynthesis).
 * Hold Right ⌥ (or the mic button) to talk, release to send. Esc stops it talking.
 */

type Engine = 'browser' | 'local';
interface VoicePrefs { open: boolean; speak: boolean; voice: string; rate: number; engine: Engine; speakTyped: boolean }
const KEY = 'factory.voice.v1';

interface SpeechRec {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SRCtor = new () => SpeechRec;
const SR: SRCtor | undefined = typeof window !== 'undefined' ? ((window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SRCtor }).webkitSpeechRecognition) : undefined;

function loadPrefs(defaultSpeak: boolean): VoicePrefs {
  const base: VoicePrefs = { open: false, speak: defaultSpeak, voice: '', rate: 1.05, engine: SR ? 'browser' : 'local', speakTyped: false };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>) };
  } catch {
    return base;
  }
}

/** The best-sounding local English voice we can find, unless you picked one. */
function pickVoice(voices: SpeechSynthesisVoice[], wanted: string) {
  return voices.find((v) => v.voiceURI === wanted)
    ?? voices.find((v) => /premium|enhanced|siri/i.test(v.name) && v.lang.startsWith('en'))
    ?? voices.find((v) => v.localService && v.lang === 'en-US')
    ?? voices.find((v) => v.lang.startsWith('en'));
}

export function speakable(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' (code in the panel) ').replace(/https?:\/\/\S+/g, 'the link').replace(/[`*_#>]/g, '').replace(/\b([A-Z]{2,})-(\d+)\b/g, '$1 $2');
}

export function AssistantDock() {
  const f = useFactory();
  const ui = useUI();
  const [prefs, setPrefsState] = useState<VoicePrefs>(() => loadPrefs(f.settings?.assistant.speak ?? true));
  const setPrefs = (p: Partial<VoicePrefs>) => setPrefsState((cur) => {
    const next = { ...cur, ...p };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const rec = useRef<SpeechRec | null>(null);
  const media = useRef<{ recorder: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null);
  const heard = useRef('');
  const voiceTurn = useRef(false);
  const feed = useRef<HTMLDivElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const interimRef = useRef('');
  interimRef.current = interim;
  const canLocal = !!f.engine?.whisper;
  const engine: Engine = prefs.engine === 'local' && canLocal ? 'local' : SR ? 'browser' : canLocal ? 'local' : 'browser';
  const canListen = engine === 'local' ? canLocal : !!SR;

  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  const stopTalking = useCallback(() => {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const say = useCallback((t: string) => {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speakable(t));
    const v = pickVoice(speechSynthesis.getVoices(), prefsRef.current.voice);
    if (v) u.voice = v;
    u.rate = prefsRef.current.rate;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    speechSynthesis.speak(u);
  }, []);

  // speak replies to what you said (and typed, if you want)
  useEffect(() => f.onAssistant((turn) => {
    if (turn.role !== 'assistant') return;
    const p = prefsRef.current;
    if (p.speak && (voiceTurn.current || p.speakTyped)) say(turn.text);
    voiceTurn.current = false;
  }), [f.onAssistant, say]);

  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [f.assistant.length, prefs.open, interim]);

  const send = useCallback(async (said: string, byVoice: boolean) => {
    const t = said.trim();
    if (!t) return;
    voiceTurn.current = byVoice;
    setBusy(true);
    try {
      await api.askAssistant(t);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [ui]);

  const startListening = useCallback(async () => {
    if (listening) return;
    stopTalking();
    heard.current = '';
    setInterim('');
    setPrefs({ open: true });
    if (engine === 'browser' && SR) {
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || 'en-US';
      r.onresult = (e) => {
        let fin = '';
        let mid = '';
        for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (mid += e.results[i][0].transcript));
        heard.current = fin;
        setInterim(`${fin}${mid}`);
      };
      r.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') ui.toast(`🎙 ${e.error === 'not-allowed' ? 'Microphone access was blocked — allow it in the browser’s site settings.' : e.error}`); };
      r.onend = () => {
        setListening(false);
        const said = heard.current || interimRef.current;
        setInterim('');
        if (said.trim()) void send(said, true);
      };
      rec.current = r;
      r.start();
      setListening(true);
      return;
    }
    if (engine === 'local') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setListening(false);
          setInterim('Transcribing…');
          try {
            const said = await api.transcribe(new Blob(chunks, { type: recorder.mimeType }));
            setInterim('');
            if (said) void send(said, true);
          } catch (e) {
            setInterim('');
            ui.toast(`🎙 ${(e as Error).message}`);
          }
        };
        media.current = { recorder, chunks, stream };
        recorder.start();
        setListening(true);
      } catch {
        ui.toast('🎙 Microphone access was blocked.');
      }
    }
  }, [listening, engine, send, stopTalking, ui]);

  const stopListening = useCallback(() => {
    if (rec.current) { rec.current.stop(); rec.current = null; }
    if (media.current) { media.current.recorder.stop(); media.current = null; }
  }, []);

  // hold Right Option anywhere in the app to talk
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'AltRight' && !e.repeat) { e.preventDefault(); void startListening(); }
      else if (e.key === 'Escape') stopTalking();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'AltRight') { e.preventDefault(); stopListening(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [startListening, stopListening, stopTalking]);

  const turns = f.assistant.slice(-40);

  if (!prefs.open) {
    return (
      <button className={`adock-fab ${listening ? 'live' : ''} ${speaking ? 'talking' : ''}`} title="Assistant — hold Right ⌥ to talk" onClick={() => setPrefs({ open: true })}>
        🎙
      </button>
    );
  }

  return (
    <aside className="adock card">
      <header className="row">
        <strong className="grow">🎙 Assistant</strong>
        <button className={`btn sm ghost ${prefs.speak ? '' : 'muted'}`} title={prefs.speak ? 'Speaking replies — click to mute' : 'Muted'} onClick={() => { if (prefs.speak) stopTalking(); setPrefs({ speak: !prefs.speak }); }}>{prefs.speak ? '🔊' : '🔇'}</button>
        <button className="btn sm ghost" title="Voice settings" onClick={() => setShowSettings((v) => !v)}>⚙</button>
        <button className="btn sm ghost" title="Clear the conversation" onClick={() => api.clearAssistant().then(() => f.refresh())}>🧹</button>
        <button className="btn sm ghost" title="Close" onClick={() => { stopListening(); setPrefs({ open: false }); }}>✕</button>
      </header>
      {showSettings && (
        <div className="asettings small">
          <label>Listen with
            <select className="select" value={engine} onChange={(e) => setPrefs({ engine: e.target.value as Engine })}>
              <option value="browser" disabled={!SR}>This browser{SR ? '' : ' (not supported here)'}</option>
              <option value="local" disabled={!canLocal}>Local Whisper{canLocal ? '' : ' (set it up in Settings → Voice)'}</option>
            </select>
          </label>
          <label>Voice
            <select className="select" value={prefs.voice} onChange={(e) => setPrefs({ voice: e.target.value })}>
              <option value="">Best available</option>
              {voices.filter((v) => v.lang.startsWith('en')).map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}{v.localService ? '' : ' (online)'}</option>)}
            </select>
          </label>
          <label>Speed <input type="range" min={0.7} max={1.6} step={0.05} value={prefs.rate} onChange={(e) => setPrefs({ rate: Number(e.target.value) })} /> {prefs.rate.toFixed(2)}×</label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={prefs.speakTyped} onChange={(e) => setPrefs({ speakTyped: e.target.checked })} /> Also speak replies to typed messages</label>
          <button className="btn sm" onClick={() => say('Hi! This is how I sound.')}>▶ Test voice</button>
          <div className="muted">Tip: macOS has better free voices under System Settings → Accessibility → Spoken Content → System voice → Manage Voices (look for “Premium”).</div>
        </div>
      )}
      <div className="afeed" ref={feed}>
        {!turns.length && (
          <div className="small muted">
            Hold <kbd>Right ⌥</kbd> or the mic and talk. Try: “what needs me?”, “start a session in {f.projects[0]?.name ?? 'my project'} to fix the flaky login test”, “start a pipeline for team invites”, “approve”.
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`aturn ${t.role}`}>
            <div className="pre">{t.text}</div>
            {t.actions?.length ? <div className="row wrap">{t.actions.map((a, i) => <span key={i} className="chip">⚡ {a}</span>)}</div> : null}
          </div>
        ))}
        {interim && <div className="aturn you interim"><div className="pre">{interim}</div></div>}
        {busy && <div className="aturn assistant small muted">…</div>}
      </div>
      <div className="row">
        <button
          className={`btn mic ${listening ? 'live' : ''}`}
          disabled={!canListen}
          title={canListen ? 'Hold to talk' : 'Speech recognition isn’t available in this browser — set up local Whisper in Settings → Voice'}
          onPointerDown={(e) => { e.preventDefault(); void startListening(); }}
          onPointerUp={stopListening}
          onPointerLeave={() => listening && stopListening()}
        >
          {listening ? '● ' : '🎙'}
        </button>
        <input
          className="input grow"
          placeholder={listening ? 'Listening…' : 'Type to the assistant…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void send(text, false); setText(''); } }}
        />
        {speaking && <button className="btn sm" onClick={stopTalking} title="Stop talking (Esc)">■</button>}
      </div>
    </aside>
  );
}
