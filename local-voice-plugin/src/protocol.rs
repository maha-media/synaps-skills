use std::fmt;

pub type Result<T> = std::result::Result<T, VoicePluginError>;

#[derive(Debug, thiserror::Error)]
pub enum VoicePluginError {
    #[error("{0}")]
    Message(String),
}

impl VoicePluginError {
    pub fn tool(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceSidecarMode {
    Dictation,
    Command,
    Conversation,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SidecarConfig {
    pub mode: VoiceSidecarMode,
    pub language: Option<String>,
    pub protocol_version: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarCommand {
    Init { config: SidecarConfig },
    VoiceControlPressed,
    VoiceControlReleased,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarCapability {
    Stt,
    BargeIn,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarProviderState {
    Ready,
    Listening,
    Transcribing,
    Speaking,
    Stopped,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarEvent {
    Hello {
        protocol_version: u16,
        extension: String,
        capabilities: Vec<SidecarCapability>,
    },
    Status {
        state: SidecarProviderState,
        capabilities: Vec<SidecarCapability>,
    },
    ListeningStarted,
    ListeningStopped,
    TranscribingStarted,
    PartialTranscript { text: String },
    FinalTranscript { text: String },
    VoiceCommand { command: String },
    BargeIn,
    Error { message: String },
}

pub const VOICE_SIDECAR_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone)]
pub enum VoiceEvent {
    ListeningStarted,
    ListeningStopped,
    PartialTranscript(String),
    FinalTranscript(String),
    Error(String),
}

pub type VoiceEventSender = tokio::sync::mpsc::Sender<VoiceEvent>;

pub trait SpeechToTextProvider: fmt::Debug + Send {
    fn start(&mut self, events: VoiceEventSender) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
    fn is_running(&self) -> bool;
}

pub fn voice_event_to_sidecar_event(event: VoiceEvent) -> Option<SidecarEvent> {
    match event {
        VoiceEvent::ListeningStarted => Some(SidecarEvent::ListeningStarted),
        VoiceEvent::ListeningStopped => Some(SidecarEvent::ListeningStopped),
        VoiceEvent::PartialTranscript(text) => Some(SidecarEvent::PartialTranscript { text }),
        VoiceEvent::FinalTranscript(text) => Some(SidecarEvent::FinalTranscript { text }),
        VoiceEvent::Error(message) => Some(SidecarEvent::Error { message }),
    }
}
