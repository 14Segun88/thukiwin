/**
 * Sound tab - notification sound and TTS voice settings.
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { Section, NumberSlider } from '../components';
import { SaveField } from '../components/SaveField';
import { configHelp } from '../configHelpers';
import styles from '../../styles/settings.module.css';
import type { RawAppConfig } from '../types';

type NotificationSound = 'system' | 'custom' | 'none';

const NOTIFICATION_OPTIONS: NotificationSound[] = ['system', 'custom', 'none'];
const NOTIFICATION_LABELS: Record<NotificationSound, string> = {
  system: 'System Default',
  custom: 'Custom Sound',
  none: 'Silent',
};

interface SoundTabProps {
  config: RawAppConfig;
  resyncToken: number;
  onSaved: (next: RawAppConfig) => void;
}

export function SoundTab({ config, resyncToken, onSaved }: SoundTabProps) {
  const [ttsVoices, setTtsVoices] = useState<
    { name: string; ShortName: string; Locale: string; gender: string }[]
  >([]);
  const [notificationSound, setNotificationSound] =
    useState<NotificationSound>('system');
  /** Groq Whisper API key — stored in SQLite under api_key_groq. */
  const [groqKey, setGroqKey] = useState('');

  useEffect(() => {
    async function loadVoices() {
      try {
        const voices = await invoke<
          Array<{ name: string; ShortName: string; Locale: string; gender: string }>
        >('tts_list_voices');
        setTtsVoices(voices);
      } catch {
        // TTS not available
      }
    }
    void loadVoices();

    async function loadSettings() {
      try {
        const settings = await invoke<Record<string, string>>('get_settings');
        if (settings['notification_sound']) {
          setNotificationSound(settings['notification_sound'] as NotificationSound);
        }
        if (settings['api_key_groq']) {
          setGroqKey(settings['api_key_groq']);
        }
      } catch {
        // use default
      }
    }
    void loadSettings();
  }, []);

  async function saveNotificationSound(value: NotificationSound) {
    setNotificationSound(value);
    try {
      await invoke('set_setting', {
        key: 'notification_sound',
        value,
      });
    } catch {
      // ignore
    }
  }

  async function saveGroqKey(value: string) {
    try {
      await invoke('set_setting', { key: 'api_key_groq', value });
    } catch {
      // ignore — user sees error on next mic press
    }
  }

  const voicesByLocale = ttsVoices.reduce<
    Record<string, typeof ttsVoices>
  >((acc, v) => {
    const locale = v.Locale;
    if (!acc[locale]) acc[locale] = [];
    acc[locale].push(v);
    return acc;
  }, {});
  const sortedLocales = Object.keys(voicesByLocale).sort();

  return (
    <>
      <Section heading="Notifications">
        <div className={styles.row}>
          <div className={styles.rowLabelGroup}>
            <span className={styles.rowLabel}>Notification sound</span>
          </div>
          <div className={styles.rowControl}>
            <select
              className={styles.dropdown}
              value={notificationSound}
              aria-label="Notification sound"
              onChange={(e) =>
                saveNotificationSound(e.target.value as NotificationSound)
              }
            >
              {NOTIFICATION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {NOTIFICATION_LABELS[opt]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      <Section heading="Text-to-Speech">
        <SaveField
          section="tts"
          fieldKey="voice"
          label="Voice"
          helper={configHelp('tts', 'voice')}
          initialValue={config.tts.voice}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue, errored) =>
            sortedLocales.length > 0 ? (
              <select
                className={styles.dropdown}
                value={value}
                aria-label="TTS voice"
                onChange={(e) => setValue(e.target.value)}
              >
                {sortedLocales.map((locale) => (
                  <optgroup key={locale} label={locale}>
                    {voicesByLocale[locale].map((v) => (
                      <option key={v.ShortName} value={v.ShortName}>
                        {v.ShortName} ({v.gender})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className={`${styles.input} ${errored ? styles.inputError : ''}`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-label="TTS voice"
                spellCheck={false}
              />
            )
          }
        />
        <SaveField
          section="tts"
          fieldKey="rate"
          label="Speed"
          helper={configHelp('tts', 'rate')}
          initialValue={config.tts.rate}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberSlider
              value={value}
              min={-50}
              max={50}
              unit=""
              onChange={setValue}
              ariaLabel="TTS speed"
            />
          )}
        />
        <SaveField
          section="tts"
          fieldKey="pitch"
          label="Pitch"
          helper={configHelp('tts', 'pitch')}
          initialValue={config.tts.pitch}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <NumberSlider
              value={value}
              min={-50}
              max={50}
              unit=""
              onChange={setValue}
              ariaLabel="TTS pitch"
            />
          )}
        />
      </Section>

      <Section heading="Voice input (Groq Whisper)">
        <div className="flex flex-col gap-2">
          <label
            className="text-xs font-medium"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Groq API key
          </label>
          <input
            type="password"
            value={groqKey}
            onChange={(e) => setGroqKey(e.target.value)}
            onBlur={() => saveGroqKey(groqKey)}
            placeholder="gsk_..."
            className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
            style={{
              color: 'var(--color-text-primary)',
              padding: '4px 0',
            }}
          />
          <span
            className="text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Stored locally in SQLite. Get a free key at{' '}
            <code>console.groq.com/keys</code>. Used by the microphone
            button on the input bar to transcribe with whisper-large-v3.
          </span>
        </div>
      </Section>
    </>
  );
}