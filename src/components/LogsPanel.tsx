/**
 * In-app diagnostics panel.
 *
 * Reads from the Rust ring-buffer (`diagnostics::get_logs`) so the end user
 * can copy/paste a tail of recent backend events when something misbehaves
 * (Whisper hallucination, vision 400, Hermes silence). Frontend events that
 * matter — currently `useAsr` console logs — are mirrored into the same
 * buffer via the small `appendClientLog` helper exported below so a single
 * panel shows the full pipeline (browser MediaRecorder → Rust → Groq → text).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface LogEntry {
  ts_ms: number;
  scope: string;
  message: string;
}

/** Client-side ring buffer, mirrored into the same view as backend logs. */
const CLIENT_LIMIT = 300;
const clientBuffer: LogEntry[] = [];
const subscribers = new Set<() => void>();

/** Append a client-side log entry (call from useAsr, useTtsQueue, etc.). */
export function appendClientLog(scope: string, message: string): void {
  clientBuffer.push({ ts_ms: Date.now(), scope, message });
  if (clientBuffer.length > CLIENT_LIMIT) clientBuffer.shift();
  for (const fn of subscribers) fn();
}

function useClientLogTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return tick;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    '.' +
    pad(d.getMilliseconds(), 3)
  );
}

function scopeColor(scope: string): string {
  switch (scope) {
    case 'asr':
      return 'text-amber-300';
    case 'vision':
      return 'text-sky-300';
    case 'hermes':
      return 'text-emerald-300';
    case 'tts':
      return 'text-fuchsia-300';
    case 'error':
      return 'text-red-400';
    default:
      return 'text-text-secondary';
  }
}

interface LogsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function LogsPanel({ open, onClose }: LogsPanelProps) {
  const [serverLogs, setServerLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clientTick = useClientLogTick();

  const refresh = useCallback(async () => {
    try {
      const logs = await invoke<LogEntry[]>('get_logs');
      setServerLogs(Array.isArray(logs) ? logs : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    if (!autoRefresh) return;
    const id = window.setInterval(refresh, 1500);
    return () => window.clearInterval(id);
  }, [open, autoRefresh, refresh]);

  const merged = useMemo(() => {
    // Backend logs are timestamped on Rust side; client logs use Date.now().
    // Both use the same epoch (UNIX ms) so a stable merge by ts is enough.
    const all = [...serverLogs, ...clientBuffer];
    all.sort((a, b) => a.ts_ms - b.ts_ms);
    return all;
    // clientTick is intentionally part of the dep set to force recompute when
    // a new client log is appended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverLogs, clientTick]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [merged.length]);

  const copyAll = useCallback(async () => {
    const text = merged
      .map((e) => `[${formatTs(e.ts_ms)}] [${e.scope}] ${e.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignored — clipboard may be locked in some webview contexts
    }
  }, [merged]);

  const clearAll = useCallback(async () => {
    try {
      await invoke('clear_logs');
    } catch {
      // ignored
    }
    clientBuffer.length = 0;
    for (const fn of subscribers) fn();
    setServerLogs([]);
  }, []);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-[60] flex flex-col bg-surface-base/95 backdrop-blur-sm"
      role="dialog"
      aria-label="Diagnostics logs"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border">
        <span className="text-xs font-semibold text-text-primary">
          Diagnostics ({merged.length})
        </span>
        <label className="text-[10px] text-text-secondary flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          auto
        </label>
        <button
          type="button"
          onClick={refresh}
          className="text-[10px] px-2 py-0.5 rounded border border-surface-border text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={copyAll}
          className="text-[10px] px-2 py-0.5 rounded border border-surface-border text-text-secondary hover:text-text-primary"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="text-[10px] px-2 py-0.5 rounded border border-surface-border text-text-secondary hover:text-red-400"
        >
          Clear
        </button>
        <div className="ml-auto" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close logs"
          className="text-xs px-2 py-0.5 rounded text-text-secondary hover:text-text-primary"
        >
          ✕
        </button>
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs text-red-400">{error}</div>
      ) : null}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-snug"
      >
        {merged.length === 0 ? (
          <div className="text-text-secondary">
            No logs yet. Try the microphone or screenshot button — events from
            the ASR / vision pipeline will show up here.
          </div>
        ) : (
          merged.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              <span className="text-text-secondary">{formatTs(e.ts_ms)}</span>{' '}
              <span className={scopeColor(e.scope)}>[{e.scope}]</span>{' '}
              <span>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
