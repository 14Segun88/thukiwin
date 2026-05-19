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
      const rec = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onerror = (e) => {
        const msg = (e as ErrorEvent).message || 'Recorder error';
        setError(msg);
        setState('error');
        stopRejecterRef.current?.(new Error(msg));
        teardown();
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        });
        stopResolverRef.current?.(blob);
      };
      rec.start();
      setState('recording');
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
      if (blob.size === 0) {
        setState('idle');
        return '';
      }
      const audioBase64 = await blobToBase64(blob);
      const result = await invoke<{ text: string; model: string }>(
        'transcribe_audio',
        {
          audioBase64,
          mimeType: blob.type || 'audio/webm',
          language: language && language.trim() ? language.trim() : null,
        },
      );
      setState('idle');
      return result.text ?? '';
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'string'
            ? e
            : 'Transcription failed';
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
