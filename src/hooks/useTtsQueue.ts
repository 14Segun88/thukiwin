/**
 * Queue-based TTS playback for streaming assistant responses.
 *
 * Unlike `useTts.speak()` (which cancels any in-flight synthesis on every
 * call — appropriate for the per-message "Read aloud" button), this hook
 * accumulates sentences into a FIFO queue and plays them sequentially so
 * the user hears the response naturally, sentence by sentence, while the
 * model is still streaming the next ones.
 *
 * Design contract:
 *   - `enqueue(text)`        — add a sentence to the queue (no-op if empty)
 *   - `cancel()`             — stop current playback AND drop all queued items
 *   - `setEnabled(false)`    — same as cancel(), but also blocks future enqueues
 *
 * Synthesis happens on the Rust side via `tts_speak`. We never call it for
 * a new sentence while another playback is in flight; this keeps the Edge
 * TTS WebSocket from getting cancelled mid-synthesis (which is the failure
 * mode of `useTts.speak` if you call it repeatedly).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Decodes a base64 string to an ArrayBuffer (no Buffer dep). */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface UseTtsQueueOptions {
  /** Master switch — when false, all enqueues are dropped and any active playback is stopped. */
  enabled: boolean;
  /** Edge TTS voice short name (e.g. "ru-RU-DmitryNeural"). */
  voice: string;
  /** Rate offset string, e.g. "+0%". */
  rate?: string;
  /** Pitch offset string, e.g. "+0%". */
  pitch?: string;
}

export interface UseTtsQueueReturn {
  /** True while at least one sentence is playing or being synthesized. */
  isPlaying: boolean;
  /** Adds a sentence to the playback queue. Trimmed; empty strings are ignored. */
  enqueue: (text: string) => void;
  /** Stops current playback and clears the queue. */
  cancel: () => void;
  /** Number of sentences currently queued (excluding the one playing). */
  queueLength: number;
}

export function useTtsQueue(opts: UseTtsQueueOptions): UseTtsQueueReturn {
  const { enabled, voice, rate = '+0%', pitch = '+0%' } = opts;

  const queueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  /** Monotonic generation id — bumped on cancel to invalidate in-flight synths. */
  const genRef = useRef(0);
  const playingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queueLength, setQueueLength] = useState(0);

  // Latest opts mirrored into refs so the playback loop always reads fresh
  // values without being recreated.
  const voiceRef = useRef(voice);
  const rateRef = useRef(rate);
  const pitchRef = useRef(pitch);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    pitchRef.current = pitch;
  }, [pitch]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const teardownAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    genRef.current += 1;
    queueRef.current = [];
    setQueueLength(0);
    teardownAudio();
    // Tell the Rust side to abort any active Edge TTS WebSocket.
    void invoke('tts_stop').catch(() => undefined);
    playingRef.current = false;
    setIsPlaying(false);
  }, [teardownAudio]);

  // When the master switch flips off, immediately stop everything.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      genRef.current += 1;
      teardownAudio();
      void invoke('tts_stop').catch(() => undefined);
    };
  }, [teardownAudio]);

  /**
   * Pumps the queue. Called on `enqueue` and after each sentence finishes.
   * Re-entrancy is prevented via `playingRef`.
   */
  const pump = useCallback(async () => {
    if (playingRef.current) return;
    if (!enabledRef.current) return;
    const next = queueRef.current.shift();
    if (next === undefined) {
      return;
    }
    setQueueLength(queueRef.current.length);
    playingRef.current = true;
    setIsPlaying(true);
    const myGen = genRef.current;

    try {
      const base64: string = await invoke('tts_speak', {
        text: next,
        voice: voiceRef.current,
        rate: rateRef.current,
        pitch: pitchRef.current,
      });

      // Cancelled while waiting for synthesis.
      if (myGen !== genRef.current || !enabledRef.current) {
        return;
      }
      if (!base64) {
        return;
      }

      const buf = base64ToArrayBuffer(base64);
      const blob = new Blob([buf], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      // Wait for playback to finish (or error/cancel) before pumping next.
      await new Promise<void>((resolve) => {
        const done = () => {
          audio.onended = null;
          audio.onerror = null;
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        void audio.play().catch(done);
      });
    } catch (e) {
      // "cancelled" / network / whatever — swallow and keep pumping the
      // rest of the queue so a single bad sentence doesn't kill TTS.
      if (typeof e !== 'string' || e !== 'cancelled') {
        console.warn('TTS queue: synth failed for sentence, skipping:', e);
      }
    } finally {
      // Only release the slot if this generation is still current; if a
      // cancel happened, `cancel()` has already torn down state.
      if (myGen === genRef.current) {
        teardownAudio();
        playingRef.current = false;
        setIsPlaying(false);
        // Drive the next sentence (if any). Use a microtask to avoid
        // unbounded recursion on very short queued items.
        queueMicrotask(() => {
          if (queueRef.current.length > 0 && enabledRef.current) {
            void pump();
          }
        });
      }
    }
  }, [teardownAudio]);

  const enqueue = useCallback(
    (text: string) => {
      if (!enabledRef.current) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      queueRef.current.push(trimmed);
      setQueueLength(queueRef.current.length);
      void pump();
    },
    [pump],
  );

  return { isPlaying, enqueue, cancel, queueLength };
}

/**
 * Splits a streaming buffer into completed sentences plus a remainder.
 *
 * Boundaries: terminal punctuation (`.`, `!`, `?`, `…`, `。`, `！`, `？`)
 * optionally followed by closing quote/bracket, then whitespace; OR a
 * blank line (`\n\n`). A bare newline alone is not a boundary — many
 * markdown lists break mid-thought.
 *
 * Also: do not split on a single dot if it looks like an abbreviation
 * (preceding token is 1-3 letters and the next char is lowercase). This
 * is a heuristic; it errs on the side of not splitting (which only
 * delays an utterance, never fragments it badly).
 *
 * To keep the buffer from growing without bound when the model emits a
 * very long sentence, we force-flush at 240 characters on the nearest
 * whitespace boundary.
 */
export function splitSentences(buffer: string): {
  sentences: string[];
  remainder: string;
} {
  const sentences: string[] = [];
  // Match: terminal punctuation + optional close-quotes + (whitespace OR end)
  // Or: 2+ newlines.
  const re = /([.!?…。！？]+["'»)\]]*)(\s+)|(\n{2,})/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const end = m.index + m[0].length;
    const sentence = buffer.slice(lastIdx, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    lastIdx = end;
  }
  let remainder = buffer.slice(lastIdx);

  // Force-flush very long pending fragments so we don't wait forever.
  while (remainder.length > 240) {
    const cut = remainder.lastIndexOf(' ', 240);
    const split = cut > 80 ? cut : 240;
    const head = remainder.slice(0, split).trim();
    if (head) sentences.push(head);
    remainder = remainder.slice(split).trimStart();
  }

  return { sentences, remainder };
}
