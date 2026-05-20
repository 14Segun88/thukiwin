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
 * Note: there is no API to *force* MediaRecorder onto a specific
 * device in our useAsr hook today — Windows / WebView2 returns the
 * default. The picker here is a diagnostic: once the user identifies
 * the working device, they switch Windows default to it in Sound
 * settings. We surface a clear "Open Windows Sound settings" shortcut
 * to make that one click away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface AudioInput {
  deviceId: string;
  label: string;
}

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
    // Refresh when devices are plugged/unplugged.
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Input device"
          className="flex-1 bg-transparent border border-white/20 rounded px-2 py-1 text-xs"
          style={{ color: 'var(--color-text-primary)' }}
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
        <button
          type="button"
          onClick={isActive ? stop : start}
          className="text-xs px-3 py-1 rounded border border-white/20 hover:bg-white/8"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {isActive ? 'Stop' : 'Test'}
        </button>
        <button
          type="button"
          onClick={() => void loadDevices()}
          className="text-xs px-2 py-1 rounded border border-white/20 hover:bg-white/8"
          style={{ color: 'var(--color-text-secondary)' }}
          title="Re-scan input devices"
        >
          ↻
        </button>
      </div>

      <div
        className="flex items-center gap-1 h-6 px-2 rounded bg-black/30 border border-white/10"
        aria-label="Microphone level meter"
      >
        {bars.map((_, i) => {
          const isLit = i < litCount;
          const color = i < 14 ? '#34d399' : i < 20 ? '#fbbf24' : '#f87171';
          return (
            <div
              key={i}
              style={{
                width: 4,
                height: isLit ? 16 : 4,
                background: isLit ? color : 'rgba(255,255,255,0.12)',
                borderRadius: 1,
                transition: 'height 60ms linear, background 60ms linear',
              }}
            />
          );
        })}
      </div>

      <div
        className="flex items-center justify-between text-[11px]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span>
          live:&nbsp;
          <code>{level.toFixed(4)}</code>&nbsp; peak:&nbsp;
          <code>{peak.toFixed(4)}</code>
        </span>
        <span>
          {isActive
            ? peak < 0.005
              ? 'Silent — speak into the mic; if the bar stays empty this device is not capturing audio.'
              : peak < 0.05
                ? 'Very quiet — try a closer mic or raise input level in Windows.'
                : 'Signal OK ✓'
            : 'Click Test, then speak. Bars should bounce.'}
        </span>
      </div>

      {error ? (
        <div className="text-[11px]" style={{ color: '#f87171' }}>
          {error}
        </div>
      ) : null}

      <div
        className="text-[11px]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        ThukiWin records with the <strong>Windows default</strong> input.
        Whatever device shows a green signal here is the one to set as
        default in Settings → System → Sound → Input.
      </div>
    </div>
  );
}
