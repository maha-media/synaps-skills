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

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarCommand {
    Init { config: serde_json::Value },
    Trigger {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsertTextMode {
    Append,
    Final,
    Replace,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarFrame {
    Hello {
        capabilities: Vec<String>,
    },
    Status {
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    InsertText {
        text: String,
        mode: InsertTextMode,
    },
    Error {
        message: String,
    },
    Custom {
        event_type: String,
        payload: serde_json::Value,
    },
}

pub const SIDECAR_PROTOCOL_VERSION: u16 = 2;

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

pub fn voice_event_to_sidecar_frame(event: VoiceEvent) -> Option<SidecarFrame> {
    match event {
        VoiceEvent::ListeningStarted => Some(SidecarFrame::Status {
            state: "listening".to_string(),
            label: Some("Listening".to_string()),
        }),
        VoiceEvent::ListeningStopped => Some(SidecarFrame::Status {
            state: "stopped".to_string(),
            label: None,
        }),
        VoiceEvent::PartialTranscript(text) => Some(SidecarFrame::InsertText {
            text,
            mode: InsertTextMode::Append,
        }),
        VoiceEvent::FinalTranscript(text) => Some(SidecarFrame::InsertText {
            text,
            mode: InsertTextMode::Final,
        }),
        VoiceEvent::Error(message) => Some(SidecarFrame::Error { message }),
    }
}
