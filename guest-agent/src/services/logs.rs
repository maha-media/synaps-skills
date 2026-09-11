//! Bounded per-service log ring (VM-Sites spec §6 D3 "Observation").
//!
//! Captured stdout/stderr lines are kept in a ring capped by BOTH byte volume
//! and entry count. Eviction is oldest-first and counted (`dropped`) so a
//! reader can see that a gap exists; `seq` is a monotonic per-generation
//! cursor (`next` = the seq a follow-up read should start from). Every line
//! is size-capped before it enters the ring so a runaway process cannot
//! exhaust memory with a single unterminated line.

use std::collections::VecDeque;

use chrono::{SecondsFormat, Utc};

pub use crate::pria_client::AppLogEntry as LogEntry;

/// Per-line byte cap (UTF-8 char boundary respected). Longer lines are cut
/// and suffixed with `…[truncated]`.
pub const MAX_LINE_BYTES: usize = 8 * 1024;

/// Hard ceiling for a single `GET /logs` page.
pub const MAX_PAGE_LIMIT: usize = 500;

/// Default page size when `limit` is omitted.
pub const DEFAULT_PAGE_LIMIT: usize = 200;

/// A page of log entries plus the resume cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    /// Opaque cursor for the next read (the seq after the last returned entry,
    /// or the requested cursor when nothing new was available).
    pub next: u64,
    /// Total entries evicted from this ring so far.
    pub dropped: u64,
}

/// The ring itself. Callers hold it behind a mutex.
#[derive(Debug)]
pub struct LogRing {
    entries: VecDeque<LogEntry>,
    bytes: usize,
    max_bytes: usize,
    max_entries: usize,
    next_seq: u64,
    dropped: u64,
}

/// RFC 3339 UTC with millisecond precision (`2026-09-11T10:00:00.123Z`).
pub fn now_ts() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Cut `line` to at most `MAX_LINE_BYTES` (on a char boundary), marking the
/// cut. Also strips a trailing `\r` (CRLF output from Windows-flavoured tools).
pub fn bound_line(mut line: String) -> String {
    if line.ends_with('\r') {
        line.pop();
    }
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let mut cut = MAX_LINE_BYTES;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    line.truncate(cut);
    line.push_str("…[truncated]");
    line
}

impl LogRing {
    pub fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            max_bytes: max_bytes.max(MAX_LINE_BYTES),
            max_entries: max_entries.max(1),
            next_seq: 1,
            dropped: 0,
        }
    }

    /// Append one line for `stream` (`stdout`/`stderr`); evicts oldest
    /// entries until both caps hold. Returns the stored entry (for fan-out).
    pub fn push(&mut self, stream: &str, line: String) -> LogEntry {
        let line = bound_line(line);
        let entry = LogEntry {
            seq: self.next_seq,
            ts: now_ts(),
            stream: stream.to_string(),
            line,
        };
        self.next_seq += 1;
        self.bytes += entry.line.len();
        self.entries.push_back(entry.clone());
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            match self.entries.pop_front() {
                Some(old) => {
                    self.bytes -= old.line.len();
                    self.dropped += 1;
                }
                None => break,
            }
        }
        entry
    }

    /// Read up to `limit` entries with `seq >= cursor` (cursor `None` = the
    /// oldest retained entry). `limit` is clamped to [`MAX_PAGE_LIMIT`].
    pub fn read(&self, cursor: Option<u64>, limit: usize) -> LogPage {
        let limit = limit.clamp(1, MAX_PAGE_LIMIT);
        let start = cursor.unwrap_or(0);
        // Entries are contiguous and ascending, so the first candidate index
        // is a simple offset from the oldest retained seq.
        let first_seq = self.entries.front().map(|e| e.seq).unwrap_or(self.next_seq);
        let skip = start.saturating_sub(first_seq) as usize;
        let entries: Vec<LogEntry> = self
            .entries
            .iter()
            .skip(skip)
            .take(limit)
            .cloned()
            .collect();
        let next = match entries.last() {
            Some(last) => last.seq + 1,
            // Nothing new: echo the cursor, pinned into [oldest, head] so a
            // cursor that ran ahead of reality cannot skip future lines.
            None => start.clamp(first_seq, self.next_seq),
        };
        LogPage {
            entries,
            next,
            dropped: self.dropped,
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The seq the next pushed line will receive.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_is_monotonic_and_cursor_resumes() {
        let mut ring = LogRing::new(1 << 20, 100);
        for i in 0..5 {
            ring.push("stdout", format!("l{i}"));
        }
        let p1 = ring.read(None, 2);
        assert_eq!(p1.entries.len(), 2);
        assert_eq!(p1.entries[0].seq, 1);
        assert_eq!(p1.next, 3);
        let p2 = ring.read(Some(p1.next), 10);
        assert_eq!(p2.entries.len(), 3);
        assert_eq!(p2.entries[0].seq, 3);
        assert_eq!(p2.next, 6);
        // Nothing new: cursor is echoed back, not rewound.
        let p3 = ring.read(Some(p2.next), 10);
        assert!(p3.entries.is_empty());
        assert_eq!(p3.next, 6);
    }

    #[test]
    fn entry_cap_evicts_oldest_and_counts_dropped() {
        let mut ring = LogRing::new(1 << 20, 3);
        for i in 0..5 {
            ring.push("stderr", format!("l{i}"));
        }
        assert_eq!(ring.len(), 3);
        assert_eq!(ring.dropped(), 2);
        let page = ring.read(None, 10);
        assert_eq!(page.entries[0].seq, 3);
        assert_eq!(page.dropped, 2);
        // A cursor into the evicted past starts at the oldest retained entry.
        let page = ring.read(Some(1), 10);
        assert_eq!(page.entries[0].seq, 3);
    }

    #[test]
    fn byte_cap_evicts_oldest() {
        // max_bytes is floored at MAX_LINE_BYTES; push lines of 4 KiB each.
        let mut ring = LogRing::new(MAX_LINE_BYTES, 100);
        ring.push("stdout", "a".repeat(4096));
        ring.push("stdout", "b".repeat(4096));
        assert_eq!(ring.len(), 2);
        ring.push("stdout", "c".repeat(4096));
        assert_eq!(ring.len(), 2, "third 4 KiB line must evict the first");
        assert_eq!(ring.dropped(), 1);
    }

    #[test]
    fn long_lines_are_cut_on_char_boundary() {
        let s = "é".repeat(MAX_LINE_BYTES); // 2 bytes each → over the cap
        let out = bound_line(s);
        assert!(out.ends_with("…[truncated]"));
        assert!(out.len() <= MAX_LINE_BYTES + "…[truncated]".len());
        assert_eq!(bound_line("x\r".into()), "x");
    }

    #[test]
    fn page_limit_is_clamped() {
        let mut ring = LogRing::new(1 << 20, 10_000);
        for i in 0..1000 {
            ring.push("stdout", i.to_string());
        }
        assert_eq!(ring.read(None, 10_000).entries.len(), MAX_PAGE_LIMIT);
        assert_eq!(ring.read(None, 0).entries.len(), 1);
    }
}
