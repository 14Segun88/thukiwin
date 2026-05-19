/**
 * Agent tab - provider, model, base URL, and API key for agent mode.
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { Section, TextField, Dropdown } from '../components';
import { SaveField } from '../components/SaveField';
import { configHelp } from '../configHelpers';
import type { RawAppConfig } from '../types';

type AgentProvider = 'ollama' | 'openai' | 'anthropic' | 'hermes';

const PROVIDERS: AgentProvider[] = ['ollama', 'openai', 'anthropic', 'hermes'];
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  ollama: 'Ollama (Local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  hermes: 'Hermes (NVIDIA NIM via VPS)',
};

interface AgentTabProps {
  config: RawAppConfig;
  resyncToken: number;
  onSaved: (next: RawAppConfig) => void;
}

export function AgentTab({ config, resyncToken, onSaved }: AgentTabProps) {
  const [apiKey, setApiKey] = useState('');
  const provider = config.agent.provider as AgentProvider;

  // Load API key from SQLite (not in TOML for security).
  // Re-load whenever the active provider changes so the field shows the
  // correct key for the currently-selected backend. The source of truth
  // for "which provider is active" is the TOML config (config.agent.provider),
  // NOT settings['agent_provider'] — the latter was an old code path that
  // wasn't updated when SaveField was introduced for the agent section.
  useEffect(() => {
    async function loadApiKey() {
      if (provider === 'ollama') {
        setApiKey('');
        return;
      }
      try {
        const settings = await invoke<Record<string, string>>('get_settings');
        const stored = settings[`api_key_${provider}`];
        setApiKey(stored || '');
      } catch {
        setApiKey('');
      }
    }
    void loadApiKey();
  }, [provider]);

  async function saveApiKey(key: string) {
    try {
      if (provider !== 'ollama') {
        await invoke('set_setting', { key: `api_key_${provider}`, value: key });
        // Mirror the active provider into the DB so legacy code paths
        // (search pipeline, agent loop bootstrap, etc.) that still read
        // settings['agent_provider'] see the correct value. The TOML
        // remains the canonical source.
        await invoke('set_setting', { key: 'agent_provider', value: provider });
      }
    } catch {
      // ignore — user will see a connection error on next request
    }
  }

  return (
    <>
      <Section heading="Provider">
        <SaveField
          section="agent"
          fieldKey="provider"
          label="Provider"
          helper={configHelp('agent', 'provider')}
          initialValue={config.agent.provider}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue) => (
            <Dropdown
              value={value as AgentProvider}
              options={PROVIDERS}
              onChange={(next) => setValue(next)}
              ariaLabel="Agent provider"
            />
          )}
        />
      </Section>

      <Section heading="Model">
        <SaveField
          section="agent"
          fieldKey="model"
          label="Agent model"
          helper={configHelp('agent', 'model')}
          initialValue={config.agent.model}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue, errored) => (
            <TextField
              value={value}
              onChange={setValue}
              placeholder="e.g. llama3.2, gpt-4o, claude-sonnet-4-20250514"
              errored={errored}
              ariaLabel="Agent model"
            />
          )}
        />
      </Section>

      <Section heading="Connection">
        <SaveField
          section="agent"
          fieldKey="base_url"
          label="Base URL"
          helper={configHelp('agent', 'base_url')}
          initialValue={config.agent.base_url}
          resyncToken={resyncToken}
          onSaved={onSaved}
          render={(value, setValue, errored) => (
            <TextField
              value={value}
              onChange={setValue}
              placeholder={
                provider === 'openai'
                  ? 'https://api.openai.com/v1'
                  : provider === 'anthropic'
                    ? 'https://api.anthropic.com'
                    : provider === 'hermes'
                      ? 'https://<your-tunnel>.trycloudflare.com/v1'
                      : 'http://127.0.0.1:11434'
              }
              errored={errored}
              ariaLabel="Agent base URL"
            />
          )}
        />
      </Section>

      {provider !== 'ollama' ? (
        <Section heading="API Key">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              API Key ({PROVIDER_LABELS[provider]})
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => saveApiKey(apiKey)}
              placeholder={
                provider === 'openai'
                  ? 'sk-...'
                  : provider === 'anthropic'
                    ? 'sk-ant-...'
                    : 'Hermes gateway BEARER_TOKEN'
              }
              className="w-full bg-transparent border-b border-white/20 text-sm focus:outline-none focus:border-primary"
              style={{ color: 'var(--color-text-primary)', padding: '4px 0' }}
            />
            <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Stored securely in local database, not in config.toml.
            </span>
          </div>
        </Section>
      ) : null}
    </>
  );
}