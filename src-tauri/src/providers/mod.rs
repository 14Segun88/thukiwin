//! Provider abstraction for multi-backend LLM support.
//!
//! Routes requests to the correct backend (Ollama, OpenAI, Anthropic, Hermes)
//! based on user configuration. Each provider implements the same streaming
//! interface but translates messages to its own API format.
//!
//! `Hermes` is a remote NVIDIA NIM proxy hosted on the user's VPS, exposed
//! via Cloudflare Tunnel. It speaks the OpenAI Chat Completions API on the
//! wire, so it reuses `openai::stream_openai_chat` with a different
//! base URL and bearer token — no separate transport needed.

pub mod openai;
pub mod anthropic;

use serde::{Deserialize, Serialize};

/// Supported LLM providers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    OpenAI,
    Anthropic,
    /// Hermes Agent on user's VPS — OpenAI-compatible proxy to NVIDIA NIM.
    /// See https://github.com/NousResearch/hermes-agent
    Hermes,
}

/// Runtime configuration for the active provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Which provider to use for requests.
    pub provider: Provider,
    /// Model name to send to the provider.
    pub model: String,
    /// Base URL for the provider API.
    ///
    /// - Ollama: `http://127.0.0.1:11434`
    /// - OpenAI: `https://api.openai.com/v1`
    /// - Anthropic: `https://api.anthropic.com`
    /// - Hermes:   `https://<tunnel-id>.trycloudflare.com/v1`
    pub base_url: String,
    /// API key for cloud providers (empty for Ollama).
    /// For Hermes this is the gateway BEARER_TOKEN, not the upstream NIM key.
    pub api_key: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Ollama,
            model: "gemini-3-flash-preview".to_string(),
            base_url: "http://127.0.0.1:11434".to_string(),
            api_key: String::new(),
        }
    }
}

/// A tool call from a model response.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    /// Unique ID for the tool call (used to match results).
    pub id: String,
    /// The function/tool name (e.g., "computer_click").
    pub name: String,
    /// JSON string of arguments.
    pub arguments: String,
}

/// A chunk of streaming response from any provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ProviderChunk {
    /// A text token from the model.
    Token(String),
    /// A thinking/reasoning token.
    ThinkingToken(String),
    /// The model is requesting one or more tool calls.
    ToolCalls(Vec<ToolCall>),
    /// Streaming is complete.
    Done,
    /// Streaming was cancelled by the user.
    Cancelled,
    /// An error occurred.
    Error(String),
}

/// Returns default base URLs for each provider.
///
/// For `Hermes` we return an empty string — the user MUST configure their
/// own Cloudflare Tunnel URL in Settings (the tunnel URL is per-deployment
/// and not a stable default).
pub fn default_base_url(provider: &Provider) -> &'static str {
    match provider {
        Provider::Ollama => "http://127.0.0.1:11434",
        Provider::OpenAI => "https://api.openai.com/v1",
        Provider::Anthropic => "https://api.anthropic.com",
        Provider::Hermes => "",
    }
}

/// Returns recommended models for each provider.
pub fn default_models(provider: &Provider) -> &'static [&'static str] {
    match provider {
        Provider::Ollama => &["gemini-3-flash-preview", "llama3.2-vision", "llama3.2", "mistral"],
        Provider::OpenAI => &["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
        Provider::Anthropic => &["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
        // Models exposed by our Hermes/NIM gateway (see openai_gateway.py /v1/models).
        Provider::Hermes => &[
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            "meta/llama-3.3-70b-instruct",
            "meta/llama-3.2-90b-vision-instruct",
            "nvidia/llama-3.1-nemotron-nano-8b-v1",
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_serialization() {
        assert_eq!(serde_json::to_string(&Provider::Ollama).unwrap(), "\"ollama\"");
        assert_eq!(serde_json::to_string(&Provider::OpenAI).unwrap(), "\"openai\"");
        assert_eq!(serde_json::to_string(&Provider::Anthropic).unwrap(), "\"anthropic\"");
        assert_eq!(serde_json::to_string(&Provider::Hermes).unwrap(), "\"hermes\"");
    }

    #[test]
    fn provider_config_default() {
        let config = ProviderConfig::default();
        assert_eq!(config.provider, Provider::Ollama);
        assert_eq!(config.base_url, "http://127.0.0.1:11434");
        assert!(config.api_key.is_empty());
    }

    #[test]
    fn default_base_urls() {
        assert_eq!(default_base_url(&Provider::Ollama), "http://127.0.0.1:11434");
        assert_eq!(default_base_url(&Provider::OpenAI), "https://api.openai.com/v1");
        assert_eq!(default_base_url(&Provider::Anthropic), "https://api.anthropic.com");
        assert_eq!(default_base_url(&Provider::Hermes), "");
    }

    #[test]
    fn default_models_not_empty() {
        for provider in &[Provider::Ollama, Provider::OpenAI, Provider::Anthropic, Provider::Hermes] {
            assert!(!default_models(provider).is_empty());
        }
    }

    #[test]
    fn hermes_default_models_include_nemotron() {
        let models = default_models(&Provider::Hermes);
        assert!(models.iter().any(|m| m.contains("nemotron")));
    }
}