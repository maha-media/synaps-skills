//! Background consolidation timer.
//!
//! A worker thread periodically calls Axel's `consolidate` flow without
//! requiring a host-initiated RPC. The interval is read from the shared
//! [`Settings`] on every tick (so live config reloads take effect on the
//! *next* fire) and can also be reset on demand by the file-watcher via the
//! `Rearm` command.
//!
//! All log output goes to **stderr**; stdout is reserved for JSON-RPC frames
//! emitted by the dispatch loop. The timer thread MUST NOT write to stdout.
//!
//! Lock discipline: this thread acquires the brain `Mutex` only for the
//! duration of the consolidate call. It never holds the lock across an I/O
//! write. See `main.rs::dispatch` doc-comment for the dispatch-side rule.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use axel::AxelBrain;

use crate::settings::Settings;

/// Long park duration when the timer is "disabled" (`interval == 0`). We park
/// effectively forever, only waking on a `TimerCmd` from the channel.
const PARK_FOREVER: Duration = Duration::from_secs(86_400);

/// Commands the dispatch loop / file-watcher can send to the timer thread.
#[derive(Debug, Clone)]
pub enum TimerCmd {
    /// Set the interval to `secs`. `0` means disabled (timer parks).
    Rearm(u64),
    /// Tell the timer to break its loop and exit. The thread is then joinable.
    Shutdown,
}

/// Compute how long the timer should `recv_timeout` for given the current
/// configured interval. `0` means disabled — park on a long timeout and wait
/// to be re-armed via the channel.
pub fn next_wait(interval_secs: u64) -> Duration {
    if interval_secs == 0 {
        PARK_FOREVER
    } else {
        Duration::from_secs(interval_secs)
    }
}

/// Spawn the background consolidation timer. Returns the JoinHandle; the
/// caller owns the matching `Sender<TimerCmd>` from the `mpsc::channel()`
/// pair it constructed before calling.
///
/// Behaviour:
/// * On startup, read the initial interval from `settings`.
/// * If interval is `0`, park on a long timeout (effectively wait for re-arm).
/// * On wake-from-timeout with `interval > 0`: read `min_consolidate_len`,
///   acquire the brain lock, run consolidation, release the lock, log to
///   stderr.
/// * `Rearm(n)` updates the interval and re-loops (next iteration's wait
///   reflects the new value).
/// * `Shutdown` (or channel disconnect) breaks the loop and returns.
pub fn spawn_consolidation_timer(
    brain: Arc<Mutex<Option<AxelBrain>>>,
    settings: Arc<Mutex<Settings>>,
    rx: mpsc::Receiver<TimerCmd>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("axel-consolidation-timer".into())
        .spawn(move || {
            let mut interval = settings
                .lock()
                .expect("settings lock poisoned")
                .consolidate_interval_secs;
            eprintln!("axel: bg consolidate: timer started interval_secs={interval}");
            loop {
                let wait = next_wait(interval);
                match rx.recv_timeout(wait) {
                    Ok(TimerCmd::Shutdown) => {
                        eprintln!("axel: bg consolidate: shutdown received");
                        break;
                    }
                    Ok(TimerCmd::Rearm(n)) => {
                        if n != interval {
                            eprintln!("axel: bg consolidate: rearm interval_secs={n}");
                        }
                        interval = n;
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        eprintln!("axel: bg consolidate: channel disconnected; exiting");
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if interval == 0 {
                            // Disabled — re-park on the next loop iteration.
                            continue;
                        }
                        run_one_tick(&brain, &settings);
                    }
                }
            }
        })
        .expect("spawn axel-consolidation-timer thread")
}

/// Single tick: lock the brain, run consolidation, release the lock. Logs
/// timing/result to stderr. Lock is dropped before any further work.
fn run_one_tick(brain: &Arc<Mutex<Option<AxelBrain>>>, settings: &Arc<Mutex<Settings>>) {
    let min_len = settings
        .lock()
        .expect("settings lock poisoned")
        .min_consolidate_len;
    let started = Instant::now();
    eprintln!(
        "axel: bg consolidate: start min_consolidate_len={min_len} \
         ts_unix_ms={}",
        unix_ms()
    );
    let mut g = brain.lock().expect("brain lock poisoned");
    let outcome = match g.as_mut() {
        Some(b) => bg_consolidate_inner(b),
        None => Err("no brain available".to_string()),
    };
    drop(g);
    let elapsed_ms = started.elapsed().as_millis();
    match outcome {
        Ok(rows) => eprintln!("axel: bg consolidate: end rows={rows} elapsed_ms={elapsed_ms}"),
        Err(e) => eprintln!("axel: bg consolidate: failed: {e} elapsed_ms={elapsed_ms}"),
    }
}

/// Run a single consolidation pass on `brain` and return the number of
/// reindexed rows on success. Mirrors `main::run_consolidation` but is
/// kept separate so the timer's stderr formatting is identical regardless
/// of trigger source. Errors are returned (not logged here) so the caller
/// can report them as `failed: …`.
fn bg_consolidate_inner(brain: &mut AxelBrain) -> Result<u64, String> {
    use axel::consolidate::{consolidate, ConsolidateOptions};
    use std::collections::HashSet;
    let opts = ConsolidateOptions {
        sources: vec![],
        phases: HashSet::new(),
        dry_run: false,
        verbose: false,
    };
    match consolidate(brain.search_mut(), &opts) {
        Ok(stats) => Ok(stats.reindex.reindexed as u64),
        Err(e) => Err(e.to_string()),
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_wait_zero_parks_long() {
        assert_eq!(next_wait(0), PARK_FOREVER);
        assert!(next_wait(0) >= Duration::from_secs(3600));
    }

    #[test]
    fn next_wait_nonzero_is_secs() {
        assert_eq!(next_wait(1), Duration::from_secs(1));
        assert_eq!(next_wait(60), Duration::from_secs(60));
        assert_eq!(next_wait(3600), Duration::from_secs(3600));
    }

    /// Drive the channel-handling logic without spawning the real thread:
    /// rapid Rearm(0) followed by Rearm(1) must leave the local interval
    /// at 1 (no regression on quick reconfig). Mirrors the body of the
    /// real timer loop but reads commands from a vec instead of blocking.
    #[test]
    fn rearm_zero_then_one_arms_at_one() {
        let (tx, rx) = mpsc::channel::<TimerCmd>();
        tx.send(TimerCmd::Rearm(0)).unwrap();
        tx.send(TimerCmd::Rearm(1)).unwrap();
        tx.send(TimerCmd::Shutdown).unwrap();

        let mut interval: u64 = 60; // pretend we started at 60
        let mut shutdown_seen = false;
        loop {
            // Use try_recv-with-timeout-zero to drain without blocking; we
            // just want to exercise the same match arms.
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(TimerCmd::Shutdown) => {
                    shutdown_seen = true;
                    break;
                }
                Ok(TimerCmd::Rearm(n)) => {
                    interval = n;
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(shutdown_seen, "should have observed Shutdown");
        assert_eq!(interval, 1, "final interval after Rearm(0)→Rearm(1) must be 1");
    }

    /// Disconnected channel terminates the loop just like Shutdown.
    #[test]
    fn channel_disconnect_terminates() {
        let (tx, rx) = mpsc::channel::<TimerCmd>();
        drop(tx);
        let err = rx.recv_timeout(Duration::from_millis(10)).unwrap_err();
        assert!(matches!(err, RecvTimeoutError::Disconnected));
    }
}
