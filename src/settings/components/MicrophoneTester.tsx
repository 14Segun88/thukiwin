/**
 * Live microphone preview.
 *
 * Renders a device picker (all audio inputs reported by
 * `enumerateDevices`), a Test button that opens a getUserMedia stream
 * against the selected device, and a real-time VU meter driven by a
 * WebAudio AnalyserNode. The whole point is to let the user verify —
 * without leaving ThukiWin — that they have the right input selected
 * and that it actually captures sound. The Whisper integration uses
 * the OS default device; if Windows is pointed at a dead/muted input,
 * the recorder produces ~330 B/s of opus silence and Whisper either
 * hallucinates or returns nothing.
 *
 * All styling uses inline `style` props with explicit colors instead of
 * Tailwind utility classes. The settings window's CSS surface is dark
 * but the underlying html background is the OS default — relying on
 * Tailwind classes here led to invisible (white-on-white) controls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface AudioInput {
  deviceId: string;
  label: string;
}

const COLORS = {
  text: '#f0f0f2',
  textSecondary: '#a8a8ad',
  bg: '#1a1a1a',
  bgPanel: '#2a2a2a',
  border: 'rgba(255,255,255,0.15)',
  borderStrong: 'rgba(255,255,255,0.25)',
  meterEmpty: 'rgba(255,255,255,0.10)',
  meterGreen: '#34d399',
  meterAmber: '#fbbf24',
  meterRed: '#f87171',
  error: '#f87171',
};

const BUTTON: React.CSSProperties = {
  background: COLORS.bgPanel,
  color: COLORS.text,
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
  lineHeight: 1.3,
};

const SELECT: React.CSSProperties = {
  background: COLORS.bgPanel,
  color: COLORS.text,
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
  flex: 1,
  minWidth: 0,
};

export function MicrophoneTester() {
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<number>(0);
  const [peak, setPeak] = useState<number>(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      // Some browsers hide labels until at least one getUserMedia call has
      // succeeded — kick a probe to populate them.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        // permission may be denied; we still try enumerate below
      }
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs: AudioInput[] = list
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      setDevices(inputs);
      if (inputs.length > 0 && !selected) setSelected(inputs[0].deviceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selected]);

  useEffect(() => {
    void loadDevices();
    const handler = () => void loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
    };
  }, [loadDevices]);

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      void ctxRef.current?.close();
    } catch {
      // ignore
    }
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsActive(false);
    setLevel(0);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const start = useCallback(async () => {
    stop();
    setError(null);
    setPeak(0);
    try {
      const constraints: MediaStreamConstraints = {
        audio: selected
          ? {
              deviceId: { exact: selected },
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) {
        setError('AudioContext is not available in this WebView.');
        return;
      }
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      setIsActive(true);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let max = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i]);
          if (v > max) max = v;
        }
        setLevel(max);
        setPeak((p) => (max > p ? max : p));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      stop();
    }
  }, [selected, stop]);

  const bars = Array.from({ length: 24 });
  const litCount = Math.min(24, Math.round(Math.sqrt(level) * 24));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: COLORS.bg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Input device"
          style={SELECT}
        >
          {devices.length === 0 ? (
            <option value="">(no input devices found)</option>
          ) : (
            devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))
          )}
        </select>
        <button type="button" onClick={isActive ? stop : start} style={BUTTON}>
          {isActive ? 'Stop' : 'Test'}
        </button>
        <button
          type="button"
          onClick={() => void loadDevices()}
          title="Re-scan input devices"
          style={{ ...BUTTON, padding: '4px 8px' }}
        >
          ↻
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          height: 28,
          padding: '0 8px',
          borderRadius: 4,
          background: 'rgba(0,0,0,0.5)',
          border: `1px solid ${COLORS.border}`,
        }}
        aria-label="Microphone level meter"
      >
        {bars.map((_, i) => {
          const isLit = i < litCount;
          const color =
            i < 14
              ? COLORS.meterGreen
              : i < 20
                ? COLORS.meterAmber
                : COLORS.meterRed;
          return (
            <div
              key={i}
              style={{
                width: 5,
                height: isLit ? 18 : 4,
                background: isLit ? color : COLORS.meterEmpty,
                borderRadius: 1,
                transition: 'height 60ms linear, background 60ms linear',
              }}
            />
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: COLORS.textSecondary,
          gap: 8,
        }}
      >
        <span style={{ whiteSpace: 'nowrap' }}>
          live: <code style={{ color: COLORS.text }}>{level.toFixed(4)}</code>
          &nbsp;&nbsp; peak:{' '}
          <code style={{ color: COLORS.text }}>{peak.toFixed(4)}</code>
        </span>
        <span style={{ textAlign: 'right' }}>
          {isActive
            ? peak < 0.005
              ? 'Silent — speak into the mic. If the bar stays empty this device is not capturing audio.'
              : peak < 0.05
                ? 'Very quiet — try a closer mic or raise input level in Windows.'
                : 'Signal OK ✓'
            : 'Click Test, then speak. Bars should bounce.'}
        </span>
      </div>

      {error ? (
        <div style={{ fontSize: 11, color: COLORS.error }}>{error}</div>
      ) : null}

      <div style={{ fontSize: 11, color: COLORS.textSecondary }}>
        ThukiWin records with the <strong>Windows default</strong> input.
        Whatever device shows a green signal here is the one to set as default
        in Settings → System → Sound → Input.
      </div>
    </div>
  );
}
