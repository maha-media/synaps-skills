//! Task B1 — wire-compatible recall protocol types (continuous-memory spec
//! §6.4 / §6.5).
//!
//! This crate runs in a separate process and cargo workspace from the Synaps
//! host, so it cannot depend on `agent_core`. These serde structs are an
//! INDEPENDENT mirror of the host's wire JSON shape — same field names, same
//! snake_case enum strings — kept compatible by the exact-string tests below,
//! not by a shared Rust type.
//!
//! No RPC dispatch is wired here (that is task B3): this module is only the
//! typed structs, their serde (de)serialization, and the plugin-side
//! outgoing-disclosure guard [`validate_outgoing_record`].

use serde::{Deserialize, Serialize};

/// Disclosure class of a record — wire mirror of the host's
/// `agent_core::core::disclosure::DisclosureClass`. The snake_case wire
/// strings MUST match the host's `DisclosureClass::as_str()` exactly:
/// `model_visible`, `local_only`, `model_visible_after_redaction`,
/// `model_visible_after_consent`, `persist_never_transmit`, `never_persist`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisclosureClassWire {
    /// Baseline: freely model-visible and persistable.
    #[default]
    ModelVisible,
    /// Display locally only — never enters model context.
    LocalOnly,
    /// Model-visible only AFTER a redactor has been applied.
    ModelVisibleAfterRedaction,
    /// Model-visible only after explicit per-item consent.
    ModelVisibleAfterConsent,
    /// May persist to disk but never transmit.
    PersistNeverTransmit,
    /// Never persisted; visibility itself is not restricted.
    NeverPersist,
}

impl DisclosureClassWire {
    /// Canonical snake_case wire name (matches the serde representation and
    /// the host's `DisclosureClass::as_str()`).
    pub fn as_str(&self) -> &'static str {
        match self {
            DisclosureClassWire::ModelVisible => "model_visible",
            DisclosureClassWire::LocalOnly => "local_only",
            DisclosureClassWire::ModelVisibleAfterRedaction => "model_visible_after_redaction",
            DisclosureClassWire::ModelVisibleAfterConsent => "model_visible_after_consent",
            DisclosureClassWire::PersistNeverTransmit => "persist_never_transmit",
            DisclosureClassWire::NeverPersist => "never_persist",
        }
    }

    /// Parse a canonical wire name.
    pub fn parse(s: &str) -> Option<Self> {
        [
            DisclosureClassWire::ModelVisible,
            DisclosureClassWire::LocalOnly,
            DisclosureClassWire::ModelVisibleAfterRedaction,
            DisclosureClassWire::ModelVisibleAfterConsent,
            DisclosureClassWire::PersistNeverTransmit,
            DisclosureClassWire::NeverPersist,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
    }
}

/// Source class of a recalled record (spec §6.5 wire mirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceWire {
    /// Consolidated from captured chat history (spec §8).
    #[default]
    ChatHistory,
    /// Explicitly stated by the user.
    UserStated,
}

/// Why the provider ranked a record into the contribution (spec §6.5, §10.4
/// wire mirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankReasonWire {
    /// Exact topical match against the recall query.
    ExactTopic,
    /// Recency-weighted selection.
    Recency,
}

/// Retention class of a recalled record (spec §6.5 wire mirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetentionClassWire {
    /// Standard project retention.
    #[default]
    Standard,
}

/// Engine-authored recall budget (spec §6.4 / §10.3 wire mirror). The host
/// computes it; the plugin only reads it and must fit inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecallBudgetWire {
    /// Maximum records the provider may select.
    pub max_records: u32,
    /// Maximum rendered tokens the provider may return.
    pub max_rendered_tokens: u64,
}

/// One recall request as received from the host (spec §6.4 wire mirror).
/// `deny_unknown_fields`: this is INBOUND untrusted-boundary data — an
/// unexpected field means a protocol mismatch and fails closed rather than
/// being silently dropped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecallRequestWire {
    /// Recall-request schema version the host produced.
    pub schema: String,
    /// Host-minted lease authorizing this recall.
    pub lease_id: String,
    /// Project isolation boundary (spec §5.2).
    pub project_id: String,
    /// Session the recall belongs to.
    pub session_id: String,
    /// Chat turn the recall targets.
    pub turn_id: String,
    /// Bounded query derived from the current user prompt.
    pub query: String,
    /// Hex digest of the recent context window — never the transcript.
    pub recent_context_digest: String,
    /// Engine-authored §10.3 budget the plugin must fit.
    pub budget: RecallBudgetWire,
    /// Disclosure classes the host will accept back (spec §5.5). The plugin
    /// must never send a record whose class is outside this set.
    pub permitted_classes: Vec<DisclosureClassWire>,
}

/// Provider-reported recall accounting (spec §6.5, §10.4 wire mirror):
/// bounded counters only — never content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContributionAccountingWire {
    /// Candidate records considered before selection.
    pub candidates_considered: u32,
    /// Records withheld by disclosure policy (counted, never named).
    pub withheld: u32,
    /// Records truncated to fit their per-record bound.
    pub truncated: u32,
}

/// One record inside a recall contribution (spec §6.5 wire mirror).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryContributionRecordWire {
    /// Identity of the stored memory this record was recalled from.
    pub memory_id: String,
    /// Source class of the record.
    pub source: MemorySourceWire,
    /// When the underlying memory was recorded (Unix epoch milliseconds —
    /// `SystemTime` has no portable serde shape across the process boundary).
    pub timestamp_ms: u64,
    /// Why this record ranked in (explainability, spec §10.4).
    pub rank_reason: Vec<RankReasonWire>,
    /// Disclosure class of the record (spec §5.5).
    pub sensitivity: DisclosureClassWire,
    /// Retention class of the record.
    pub retention: RetentionClassWire,
    /// Record body (host re-bounds it at its own parse boundary).
    pub content: String,
    /// Whether the plugin truncated the body to fit its bound.
    pub truncated: bool,
    /// The memory this record supersedes, if any.
    pub supersedes: Option<String>,
}

/// A recall contribution for one turn as sent to the host (spec §6.5 wire
/// mirror).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryContextContributionWire {
    /// Contribution schema version this plugin produced.
    pub schema: String,
    /// The provider that produced this contribution.
    pub provider_id: String,
    /// Project isolation boundary the records belong to (spec §5.2).
    pub project_id: String,
    /// The selected records.
    pub records: Vec<MemoryContributionRecordWire>,
    /// The rendered text the host budgets.
    pub rendered: String,
    /// Bounded recall accounting counters.
    pub accounting: ContributionAccountingWire,
}

/// Plugin-side outgoing disclosure guard (spec §5.5 / §14.2, task B1) —
/// belt-and-suspenders mirror of the host's rejection rule: this plugin
/// must NEVER even attempt to send a withheld-class record with a body. The
/// host independently rejects such records; this guard refuses to
/// construct/serialize one in the first place.
///
/// Rule: any class other than `ModelVisible` with NON-EMPTY content is
/// refused (stricter than the host's gate — the plugin only ever ships
/// baseline model-visible bodies; empty-content records of other classes
/// are marker-only and pass).
pub fn validate_outgoing_record(
    record: &MemoryContributionRecordWire,
) -> Result<(), &'static str> {
    if record.sensitivity != DisclosureClassWire::ModelVisible && !record.content.is_empty() {
        return Err("refusing to send non-model_visible record content");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(class: DisclosureClassWire, content: &str) -> MemoryContributionRecordWire {
        MemoryContributionRecordWire {
            memory_id: "mem-0001".into(),
            source: MemorySourceWire::ChatHistory,
            timestamp_ms: 1_700_000_000_000,
            rank_reason: vec![RankReasonWire::ExactTopic, RankReasonWire::Recency],
            sensitivity: class,
            retention: RetentionClassWire::Standard,
            content: content.into(),
            truncated: false,
            supersedes: Some("mem-0000".into()),
        }
    }

    fn sample_contribution() -> MemoryContextContributionWire {
        MemoryContextContributionWire {
            schema: "contribution/1".into(),
            provider_id: "axel-memory".into(),
            project_id: "project-a".into(),
            records: vec![sample_record(
                DisclosureClassWire::ModelVisible,
                "session-scoped authorization decision",
            )],
            rendered: "## Recalled memory\n- session-scoped authorization decision\n".into(),
            accounting: ContributionAccountingWire {
                candidates_considered: 4,
                withheld: 1,
                truncated: 0,
            },
        }
    }

    fn sample_request() -> RecallRequestWire {
        RecallRequestWire {
            schema: "recall/1".into(),
            lease_id: "memctx-lease-1".into(),
            project_id: "project-a".into(),
            session_id: "sess-1".into(),
            turn_id: "turn-7".into(),
            query: "how is auth scoped?".into(),
            recent_context_digest: "ab".repeat(32),
            budget: RecallBudgetWire {
                max_records: 8,
                max_rendered_tokens: 4096,
            },
            permitted_classes: vec![DisclosureClassWire::ModelVisible],
        }
    }

    /// The wire strings MUST byte-for-byte match the host's
    /// `DisclosureClass::as_str()` vocabulary — this test IS the
    /// cross-workspace compatibility contract.
    #[test]
    fn disclosure_class_wire_strings_match_the_host_vocabulary_exactly() {
        let expected = [
            (DisclosureClassWire::ModelVisible, "model_visible"),
            (DisclosureClassWire::LocalOnly, "local_only"),
            (
                DisclosureClassWire::ModelVisibleAfterRedaction,
                "model_visible_after_redaction",
            ),
            (
                DisclosureClassWire::ModelVisibleAfterConsent,
                "model_visible_after_consent",
            ),
            (
                DisclosureClassWire::PersistNeverTransmit,
                "persist_never_transmit",
            ),
            (DisclosureClassWire::NeverPersist, "never_persist"),
        ];
        for (class, wire) in expected {
            // as_str, serde serialization, serde deserialization, and parse
            // all agree on the exact string.
            assert_eq!(class.as_str(), wire);
            assert_eq!(
                serde_json::to_value(class).unwrap(),
                serde_json::Value::String(wire.to_string())
            );
            let parsed: DisclosureClassWire =
                serde_json::from_value(serde_json::Value::String(wire.to_string())).unwrap();
            assert_eq!(parsed, class);
            assert_eq!(DisclosureClassWire::parse(wire), Some(class));
        }
        // Unknown strings fail closed in both paths.
        assert_eq!(DisclosureClassWire::parse("secret"), None);
        assert!(serde_json::from_value::<DisclosureClassWire>(serde_json::Value::String(
            "secret".into()
        ))
        .is_err());
    }

    /// Every wire type survives a serde JSON round trip bit-for-bit.
    #[test]
    fn recall_request_wire_round_trips_through_serde_json() {
        let request = sample_request();
        let json = serde_json::to_string(&request).unwrap();
        let back: RecallRequestWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, request);
    }

    /// Inbound requests fail closed on unknown fields (protocol mismatch is
    /// an error, never silently dropped data).
    #[test]
    fn recall_request_wire_rejects_unknown_fields() {
        let mut value = serde_json::to_value(sample_request()).unwrap();
        value["hidden_system_instructions"] = serde_json::Value::String("injected".into());
        assert!(serde_json::from_value::<RecallRequestWire>(value).is_err());
    }

    #[test]
    fn contribution_wire_round_trips_through_serde_json() {
        let contribution = sample_contribution();
        let json = serde_json::to_string(&contribution).unwrap();
        let back: MemoryContextContributionWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back, contribution);
    }

    #[test]
    fn contribution_record_wire_round_trips_through_serde_json() {
        for class in [
            DisclosureClassWire::ModelVisible,
            DisclosureClassWire::LocalOnly,
            DisclosureClassWire::NeverPersist,
        ] {
            let record = sample_record(class, "body");
            let json = serde_json::to_string(&record).unwrap();
            let back: MemoryContributionRecordWire = serde_json::from_str(&json).unwrap();
            assert_eq!(back, record);
        }
    }

    /// The outgoing guard refuses ANY non-model_visible class carrying a
    /// body — including `never_persist`, which the HOST's gate would show:
    /// the plugin side is deliberately stricter (it only ships baseline
    /// model-visible bodies).
    #[test]
    fn validate_outgoing_record_refuses_withheld_class_content() {
        for class in [
            DisclosureClassWire::LocalOnly,
            DisclosureClassWire::ModelVisibleAfterRedaction,
            DisclosureClassWire::ModelVisibleAfterConsent,
            DisclosureClassWire::PersistNeverTransmit,
            DisclosureClassWire::NeverPersist,
        ] {
            let record = sample_record(class, "must never leave the plugin");
            assert!(
                validate_outgoing_record(&record).is_err(),
                "class {class:?} with a body must be refused"
            );
        }
    }

    /// Marker-only (empty-content) records of a withheld class pass, and
    /// baseline model_visible records with a body pass.
    #[test]
    fn validate_outgoing_record_accepts_markers_and_model_visible_bodies() {
        for class in [
            DisclosureClassWire::LocalOnly,
            DisclosureClassWire::PersistNeverTransmit,
            DisclosureClassWire::NeverPersist,
        ] {
            let marker = sample_record(class, "");
            assert_eq!(validate_outgoing_record(&marker), Ok(()));
        }
        let visible = sample_record(DisclosureClassWire::ModelVisible, "a recalled fact");
        assert_eq!(validate_outgoing_record(&visible), Ok(()));
    }
}
