use std::io::{self, Write};
#[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
use std::path::PathBuf;

use crate::protocol::{
    voice_event_to_sidecar_frame, InsertTextMode, SidecarCommand, SidecarFrame, VoiceEvent,
    SIDECAR_PROTOCOL_VERSION,
};
#[cfg(feature = "voice-stt-whisper")]
use crate::protocol::SpeechToTextProvider;
#[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
mod audio;
mod build_info;
mod commands;
mod extension_rpc;
mod protocol;
mod settings;
#[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
mod vad;
#[cfg(feature = "voice-stt-whisper")]
mod stt_whisper;
#[cfg(feature = "voice-stt-whisper")]
use stt_whisper::{expand_whisper_model_path, WhisperSttProvider};

fn emit(frame: &SidecarFrame) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, frame)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn emit_ready() -> io::Result<()> {
    emit(&SidecarFrame::Hello {
        protocol_version: SIDECAR_PROTOCOL_VERSION,
        extension: "local-voice".to_string(),
        capabilities: vec!["insert-text".to_string(), "status".to_string()],
    })?;
    emit(&SidecarFrame::Status {
        state: "ready".to_string(),
        label: None,
    })
}

fn emit_error(message: impl Into<String>) -> io::Result<()> {
    emit(&SidecarFrame::Error {
        message: message.into(),
    })
}

fn arg_value(flag: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

struct LocalVoiceSidecar {
    mock_transcript: Option<String>,
    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    model_path: Option<PathBuf>,
    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    language: Option<String>,
    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    voice_tx: tokio::sync::mpsc::Sender<VoiceEvent>,
    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    stt: Option<WhisperSttProvider>,
}

impl LocalVoiceSidecar {
    fn new(_voice_tx: tokio::sync::mpsc::Sender<VoiceEvent>) -> Self {
        Self {
            mock_transcript: arg_value("--mock-transcript"),
            #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
            model_path: arg_value("--model-path").map(PathBuf::from),
            #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
            language: arg_value("--language"),
            #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
            voice_tx: _voice_tx,
            #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
            stt: None,
        }
    }

    fn handle_init(&mut self) -> io::Result<()> {
        emit_ready()
    }

    fn handle_press(&mut self) -> io::Result<()> {
        eprintln!("synaps-voice-local: voice_control_pressed");
        if self.mock_transcript.is_some() {
            return emit(&SidecarFrame::Status {
                state: "listening".to_string(),
                label: Some("Listening".to_string()),
            });
        }
        self.start_real_stt()
    }

    fn handle_release(&mut self) -> io::Result<()> {
        eprintln!("synaps-voice-local: voice_control_released");
        if let Some(text) = &self.mock_transcript {
            emit(&SidecarFrame::Status {
                state: "stopped".to_string(),
                label: None,
            })?;
            emit(&SidecarFrame::Status {
                state: "processing".to_string(),
                label: Some("Processing".to_string()),
            })?;
            return emit(&SidecarFrame::InsertText {
                text: text.clone(),
                mode: InsertTextMode::Final,
            });
        }
        emit(&SidecarFrame::Status {
            state: "processing".to_string(),
            label: Some("Processing".to_string()),
        })?;
        self.stop_real_stt()
    }

    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    fn start_real_stt(&mut self) -> io::Result<()> {
        if self.stt.as_ref().is_some_and(|provider| provider.is_running()) {
            return Ok(());
        }
        let Some(model_path) = self.model_path.clone().map(|path| expand_whisper_model_path(&path)) else {
            return emit_error("local voice sidecar requires --model-path unless --mock-transcript is used");
        };
        let mut provider = match WhisperSttProvider::new(model_path, self.language.clone()) {
            Ok(provider) => provider,
            Err(err) => return emit_error(err.to_string()),
        };
        if let Err(err) = provider.start(self.voice_tx.clone()) {
            return emit_error(err.to_string());
        }
        eprintln!("synaps-voice-local: real STT started");
        self.stt = Some(provider);
        Ok(())
    }

    #[cfg(not(all(feature = "voice-stt-whisper", feature = "voice-mic")))]
    fn start_real_stt(&mut self) -> io::Result<()> {
        emit_error("local voice sidecar was built without voice-stt-whisper and voice-mic features; use --mock-transcript or rebuild with local voice features")
    }

    #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
    fn stop_real_stt(&mut self) -> io::Result<()> {
        if let Some(provider) = self.stt.as_mut() {
            if let Err(err) = provider.stop() {
                return emit_error(err.to_string());
            }
        }
        Ok(())
    }

    #[cfg(not(all(feature = "voice-stt-whisper", feature = "voice-mic")))]
    fn stop_real_stt(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn shutdown(&mut self) {
        #[cfg(all(feature = "voice-stt-whisper", feature = "voice-mic"))]
        if let Some(provider) = self.stt.as_mut() {
            let _ = provider.stop();
        }
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    if std::env::args().skip(1).any(|a| a == "--extension-rpc") {
        return extension_rpc::run().await;
    }

    if std::env::args().skip(1).any(|a| a == "--print-build-info") {
        let info = build_info::current();
        println!("{}", serde_json::to_string(&info).unwrap());
        return Ok(());
    }

    let (voice_tx, mut voice_rx) = tokio::sync::mpsc::channel::<VoiceEvent>(128);
    let mut sidecar = LocalVoiceSidecar::new(voice_tx);
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut lines = tokio::io::AsyncBufReadExt::lines(stdin);

    loop {
        tokio::select! {
            maybe_line = lines.next_line() => {
                let Some(line) = maybe_line? else { break; };
                if line.trim().is_empty() {
                    continue;
                }
                let command: SidecarCommand = match serde_json::from_str(&line) {
                    Ok(command) => command,
                    Err(err) => {
                        emit_error(format!("invalid sidecar command: {err}"))?;
                        continue;
                    }
                };

                match command {
                    SidecarCommand::Init { .. } => sidecar.handle_init()?,
                    SidecarCommand::Trigger { name, .. } if name == "press" => sidecar.handle_press()?,
                    SidecarCommand::Trigger { name, .. } if name == "release" => sidecar.handle_release()?,
                    SidecarCommand::Trigger { name, .. } => {
                        emit_error(format!("unsupported trigger: {name}"))?;
                    }
                    SidecarCommand::Shutdown => break,
                }
            }
            maybe_voice = voice_rx.recv(), if !voice_rx.is_closed() => {
            if let Some(frame) = maybe_voice.and_then(voice_event_to_sidecar_frame) {
                eprintln!("synaps-voice-local: emitting {:?}", frame);
                emit(&frame)?;
            }
            }
        }
    }

    sidecar.shutdown();
    Ok(())
}
