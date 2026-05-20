/**
 * Telegram-/WhatsApp-style recording indicator.
 *
 * Renders inline above the AskBar input when the microphone is active.
 * Shows:
 *   - red pulsing dot
 *   - live timer (mm:ss)
 *   - rolling waveform driven by the `useAsr` level samples
 *   - "Speak now…" / "Silent — check mic" hint based on observed peak
 *   - Cancel (×) and Stop&Send (✓) action buttons
 *
 * The waveform is intentionally simple: we keep the last N samples in a
 * ref-backed circular buffer and repaint via requestAnimationFrame so
 * the visual is smooth even when React's render cadence slips.
 */

import { useEffect, useRef } from 'react';

interface RecordingIndicatorProps {
  /** Current peak amplitude (0..1) from useAsr. */
  level: number;
  /** Milliseconds since recording started. */
  elapsedMs: number;
  /** Either 'recording' (red) or 'transcribing' (amber). */
  state: 'recording' | 'transcribing';
  /** Cancel without sending. */
  onCancel: () => void;
  /** Stop and transcribe. */
  onStop: () => void;
}

const HISTORY = 80;

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecordingIndicator({
  level,
  elapsedMs,
  state,
  onCancel,
  onStop,
}: RecordingIndicatorProps) {
  // Rolling sample buffer. Pushed on every level change; rendered via
  // requestAnimationFrame so the bars stay smooth even when the parent
  // re-renders at irregular intervals.
  const samplesRef = useRef<number[]>(new Array(HISTORY).fill(0));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    samplesRef.current.push(level);
    if (samplesRef.current.length > HISTORY) samplesRef.current.shift();
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let mounted = true;
    const render = () => {
      if (!mounted) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const samples = samplesRef.current;
      const barW = w / samples.length;
      const isRecording = state === 'recording';
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(0.02, Math.sqrt(samples[i] ?? 0));
        const barH = Math.max(2, s * h);
        const x = i * barW;
        const y = (h - barH) / 2;
        ctx.fillStyle = isRecording
          ? `rgba(248, 113, 113, ${0.4 + 0.6 * (i / samples.length)})`
          : `rgba(251, 191, 36, ${0.4 + 0.6 * (i / samples.length)})`;
        ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1.5), barH);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      mounted = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [state]);

  // Status text: detect a silent microphone within the first second so the
  // user knows immediately, not only after they release the button.
  let hint = 'Listening…';
  if (state === 'transcribing') {
    hint = 'Transcribing…';
  } else if (elapsedMs > 1000) {
    if (level < 0.005) hint = 'Mic silent — check Windows Sound → Input.';
    else if (level < 0.03) hint = 'Very quiet — speak closer to the mic.';
    else hint = 'Recording…';
  }

  const accent = state === 'recording' ? '#f87171' : '#fbbf24';

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 mx-2 my-1 rounded-lg border bg-black/30"
      style={{
        borderColor: state === 'recording' ? 'rgba(248,113,113,0.4)' : 'rgba(251,191,36,0.4)',
      }}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 8px ${accent}`,
          animation:
            state === 'recording' ? 'thuki-pulse 1.1s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }}
      />
      <span
        className="font-mono text-xs tabular-nums"
        style={{ color: accent, minWidth: 36 }}
      >
        {formatTime(elapsedMs)}
      </span>
      <canvas
        ref={canvasRef}
        width={240}
        height={28}
        style={{
          flex: 1,
          minWidth: 80,
          height: 28,
          background: 'transparent',
        }}
        aria-label="Audio waveform"
      />
      <span className="text-[11px] text-text-secondary truncate" title={hint}>
        {hint}
      </span>
      <button
        type="button"
        onClick={onCancel}
        title="Cancel recording (Esc)"
        aria-label="Cancel recording"
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-secondary hover:text-red-400 hover:bg-white/8"
      >
        ✕
      </button>
      <button
        type="button"
        onClick={onStop}
        title="Stop and send (Enter)"
        aria-label="Stop and transcribe"
        disabled={state !== 'recording'}
        style={{
          background: accent,
          color: '#1a1a1a',
        }}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full font-bold disabled:opacity-40"
      >
        ✓
      </button>
      <style>{`@keyframes thuki-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.35); } }`}</style>
    </div>
  );
}
