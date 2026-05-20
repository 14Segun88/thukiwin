/**
 * Microphone recording + Groq Whisper transcription hook.
 *
 * Records audio with MediaRecorder, sends it as base64 to the Rust backend
 * (`transcribe_audio` Tauri command), and returns the transcript.
 *
 * Why MediaRecorder and not WASAPI in Rust:
 *   - Tauri webview already has microphone access via getUserMedia
 *   - Single dependency (browser API) vs. cpal + samplerate + opus encoder
 *   - The audio never touches disk; bytes go straight to base64 → IPC → Groq
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { appendClientLog } from '../components/LogsPanel';

/** Internal helper — mirrors a message to both DevTools console and the
 *  in-app Diagnostics panel so end users (without DevTools) can still see
 *  what the ASR pipeline is doing. */
function asrLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log('[asr]', msg);
  appendClientLog('asr', msg);
}

export type AsrState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface UseAsrReturn {
  state: AsrState;
  /** Last error message, if any. Reset on the next start/stop cycle. */
  error: string | null;
  /** True while either recording or transcribing. UI should show a busy state. */
  isBusy: boolean;
  /** Start microphone recording. Resolves once recording has actually started. */
  start: () => Promise<void>;
  /**
   * Stop recording and transcribe. Resolves with the transcript text (may be
   * an empty string if Whisper returned nothing usable). Throws on error.
   */
  stopAndTranscribe: () => Promise<string>;
  /** Abort an in-flight recording without transcribing. */
  cancel: () => void;
}

interface UseAsrOptions {
  /** ISO-639-1 language hint sent to Whisper. Empty/undefined = autodetect. */
  language?: string;
}

/** Encodes a Blob's bytes as base64 (chunked to avoid call-stack overflow). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Picks the best supported MIME for MediaRecorder on this browser. */
function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  // MediaRecorder.isTypeSupported isn't on the type globally in older lib
  // configs, so we feature-detect at runtime.
  const Cls = (
    typeof window !== 'undefined'
      ? (window as unknown as { MediaRecorder?: typeof MediaRecorder })
          .MediaRecorder
      : undefined
  ) as
    | (typeof MediaRecorder & {
        isTypeSupported?: (mime: string) => boolean;
      })
    | undefined;
  if (Cls?.isTypeSupported) {
    for (const m of candidates) {
      if (Cls.isTypeSupported(m)) return m;
    }
  }
  return '';
}

export function useAsr(opts: UseAsrOptions = {}): UseAsrReturn {
  const { language } = opts;
  const [state, setState] = useState<AsrState>('idle');
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number>(0);
  /** Peak normalised audio amplitude observed during recording. 0 = silent,
   *  1 = clip. Used to surface a clear "your mic captured silence" error
   *  instead of letting Whisper return junk or the user wonder why their
   *  recording was skipped. */
  const peakLevelRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const stopResolverRef = useRef<((value: Blob) => void) | null>(null);
  const stopRejecterRef = useRef<((reason: unknown) => void) | null>(null);

  const teardown = useCallback(() => {
    try {
      recorderRef.current?.stream
        ?.getTracks()
        .forEach((t) => t.stop());
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    if (levelRafRef.current != null) {
      try {
        cancelAnimationFrame(levelRafRef.current);
      } catch {
        // ignore
      }
      levelRafRef.current = null;
    }
    try {
      void audioCtxRef.current?.close();
    } catch {
      // ignore
    }
    audioCtxRef.current = null;
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    stopResolverRef.current = null;
    stopRejecterRef.current = null;
  }, []);

  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const start = useCallback(async () => {
    if (recorderRef.current) return; // already recording
    setError(null);
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Mild DSP — Edge/Chrome ship these on by default but be explicit
          // so background noise doesn't ruin Whisper accuracy.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mimeType = pickMime();
      asrLog(`picked MIME: ${mimeType || '(default)'}`);
      const rec = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      peakLevelRef.current = 0;

      // Attach a real-time RMS meter via WebAudio so we can detect a
      // silent microphone (wrong device, muted in OS mixer, no input at
      // all). We deliberately do NOT analyse the encoded blob — webm/opus
      // decoding in the renderer would be expensive and pointless when the
      // raw PCM is already available from the same MediaStream.
      try {
        // Some webviews expose AudioContext under the webkit prefix.
        const Ctx = (
          window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
        ).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const tick = () => {
            if (!recorderRef.current) return;
            analyser.getFloatTimeDomainData(buf);
            let max = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = Math.abs(buf[i]);
              if (v > max) max = v;
            }
            if (max > peakLevelRef.current) peakLevelRef.current = max;
            levelRafRef.current = requestAnimationFrame(tick);
          };
          levelRafRef.current = requestAnimationFrame(tick);
        } else {
          asrLog('AudioContext unavailable — skipping level meter');
        }
      } catch (e) {
        asrLog(`level meter init failed: ${(e as Error).message}`);
      }

      let chunkCount = 0;
      let chunkBytes = 0;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunkCount += 1;
          chunkBytes += e.data.size;
          chunksRef.current.push(e.data);
        }
      };
      rec.onerror = (e) => {
        const msg = (e as ErrorEvent).message || 'Recorder error';
        asrLog(`recorder error: ${msg}`);
        setError(msg);
        setState('error');
        stopRejecterRef.current?.(new Error(msg));
        teardown();
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        });
        asrLog(
          `recorder stopped: bytes=${blob.size} type=${blob.type} duration_ms=${
            Date.now() - recordingStartedAtRef.current
          } chunks=${chunkCount} chunk_bytes=${chunkBytes} peak_level=${peakLevelRef.current.toFixed(4)}`,
        );
        stopResolverRef.current?.(blob);
      };
      // Emit a chunk every 250 ms so that even very short recordings have at
      // least one `dataavailable` event before stop; some MediaRecorder
      // implementations otherwise emit zero chunks for sub-second clips.
      rec.start(250);
      setState('recording');
      asrLog('recording started');
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'string'
            ? e
            : 'Microphone access denied';
      setError(msg);
      setState('error');
      teardown();
      throw e;
    }
  }, [teardown]);

  const stopAndTranscribe = useCallback(async (): Promise<string> => {
    const rec = recorderRef.current;
    if (!rec) {
      return '';
    }
    setState('transcribing');
    const blob: Blob = await new Promise((resolve, reject) => {
      stopResolverRef.current = resolve;
      stopRejecterRef.current = reject;
      try {
        rec.stop();
      } catch (e) {
        reject(e);
      }
    });
    // Free the mic ASAP regardless of what happens next.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;

    try {
      const recordingMs = Date.now() - recordingStartedAtRef.current;
      const peak = peakLevelRef.current;

      if (blob.size === 0) {
        const msg =
          'Recorder produced no audio. Open Windows Sound settings → Input and confirm the right microphone is selected and unmuted.';
        asrLog('empty blob — nothing to transcribe');
        setError(msg);
        setState('error');
        return '';
      }

      // Heuristic: a recording that lasted >800 ms but yielded <2 KiB of
      // opus AND had a near-zero peak amplitude is almost certainly a
      // silent / wrong-device microphone. Opus VBR can compress true
      // silence down to ~6 kbps, so a 3-second silent clip lands around
      // 2 KiB — exactly the case from the user's log
      // (1135 bytes / 3.4 s / unmeasured peak).
      const looksSilent = peak > 0 && peak < 0.005;
      if (
        recordingMs > 800 &&
        blob.size < 2048 &&
        (looksSilent || peak === 0)
      ) {
        const msg =
          `Microphone captured silence (peak ${peak.toFixed(4)}, ` +
          `${blob.size} B over ${recordingMs} ms). Check Windows ` +
          `Sound → Input: is the correct mic selected and unmuted? ` +
          `Disable "Voice Isolation" if active.`;
        asrLog(msg);
        setError(msg);
        setState('error');
        return '';
      }

      // Below this many bytes AND under ~350 ms we treat as an accidental
      // tap (the user pressed and released the mic button by mistake).
      if (blob.size < 2048 && recordingMs < 350) {
        asrLog(
          `recording too short: bytes=${blob.size} ms=${recordingMs} — skipped (likely accidental tap)`,
        );
        setState('idle');
        return '';
      }

      // Otherwise — even small blobs go to Whisper if the meter saw real
      // audio. Opus is efficient, a clear "stop" word can be <2 KiB.
      asrLog(
        `proceeding to backend: bytes=${blob.size} ms=${recordingMs} peak=${peak.toFixed(4)}`,
      );
      const audioBase64 = await blobToBase64(blob);
      asrLog(
        `sending to backend: base64_len=${audioBase64.length} mime=${blob.type}`,
      );
      const result = await invoke<{ text: string; model: string }>(
        'transcribe_audio',
        {
          audioBase64,
          mimeType: blob.type || 'audio/webm',
          language: language && language.trim() ? language.trim() : null,
        },
      );
      asrLog(`transcript: ${JSON.stringify(result)}`);
      setState('idle');
      return result.text ?? '';
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'string'
            ? e
            : 'Transcription failed';
      asrLog(`transcription failed: ${msg}`);
      setError(msg);
      setState('error');
      throw e;
    } finally {
      teardown();
    }
  }, [language, teardown]);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    teardown();
    setState('idle');
    setError(null);
  }, [teardown]);

  return {
    state,
    error,
    isBusy: state === 'recording' || state === 'transcribing',
    start,
    stopAndTranscribe,
    cancel,
  };
}
