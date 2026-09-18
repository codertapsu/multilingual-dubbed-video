//! Persistent log sink for the shell and the backend processes it spawns.
//!
//! WHY THIS EXISTS: until this module, a packaged build produced no log file at
//! any level above a single project run. The shell's only logging primitive was
//! `println!` (sidecar::log_info) while `main.rs` sets
//! `windows_subsystem = "windows"` in release — so there was no console attached
//! and every line went nowhere. The three Python workers were worse: they were
//! spawned with `Stdio::null()` outright, and the orchestrator sidecar's
//! `CommandEvent` receiver was dropped on the floor. A user whose dub failed on
//! an installed .dmg/.exe therefore had *nothing* to send back, and every bug
//! report degraded to a screenshot — which is what made the Windows-specific
//! failures (Defender quarantining a sidecar, TLS interception, blocked
//! mirrors) effectively undiagnosable from here.
//!
//! Everything lands under `<config>/logs/` — inside the same `~/VideoDubber`
//! tree the user already sees in Settings → Storage, so "send me your logs" is
//! a folder they can find. One file per producer: `shell.log` for the Rust
//! shell, `<service>.log` for each spawned backend service.
//!
//! ## Bounded by construction
//! These files are written on every launch of a long-lived desktop app, so an
//! unbounded appender would quietly eat a user's disk. Each sink is capped at
//! [`MAX_LOG_BYTES`] with exactly ONE rotated generation (`<name>.log.1`), i.e.
//! at most `2 * MAX_LOG_BYTES` per service on disk, enforced both when the sink
//! is opened and on every write.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Per-file cap before the log rotates to `<name>.log.1`. With one rotated
/// generation this bounds each service at 10 MB on disk.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// `<config>/logs` — created on demand. Returns `None` only if the directory
/// cannot be created (read-only home, exotic sandbox), in which case callers
/// fall back to their previous behaviour rather than failing a launch.
pub fn log_dir() -> Option<PathBuf> {
    let dir = crate::sidecar::resolve_config_dir().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// A size-capped, append-only text log.
///
/// Held open for the life of a spawned service (or of the process, for the
/// shell's own log). Every write goes through [`LogSink::write_line`], which is
/// what makes the cap real: handing a raw `File` to a child's stdout would let
/// a chatty worker grow the file without bound between launches.
pub struct LogSink {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    cap: u64,
}

impl LogSink {
    /// Open (or create) `<dir>/<name>.log` for appending, rotating first if the
    /// existing file has already reached the cap.
    pub fn open(dir: &Path, name: &str) -> Option<Self> {
        Self::open_with_cap(dir, name, MAX_LOG_BYTES)
    }

    /// `open` with an explicit cap — the seam the unit tests drive.
    pub fn open_with_cap(dir: &Path, name: &str, cap: u64) -> Option<Self> {
        let path = dir.join(format!("{name}.log"));
        let mut sink = Self {
            path,
            file: None,
            written: 0,
            cap,
        };
        sink.reopen()?;
        Some(sink)
    }

    /// Rotate if needed, then (re)open the appender and re-read the size.
    fn reopen(&mut self) -> Option<()> {
        let size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size >= self.cap {
            rotate(&self.path);
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok()?;
        self.written = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        self.file = Some(file);
        Some(())
    }

    /// Append one timestamped line. Failures are swallowed: logging must never
    /// be able to take the app down.
    pub fn write_line(&mut self, line: &str) {
        if self.written >= self.cap {
            // Cap reached mid-run: roll over so the newest output — the part
            // that explains the failure the user is reporting — survives.
            self.file = None;
            rotate(&self.path);
            if self.reopen().is_none() {
                return;
            }
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let record = format!("{} {}\n", iso8601_utc(SystemTime::now()), line.trim_end());
        if file.write_all(record.as_bytes()).is_ok() {
            self.written += record.len() as u64;
        }
    }
}

/// Move `<name>.log` to `<name>.log.1`, replacing any previous generation.
/// Best-effort: if the rename fails (Windows file lock), truncate instead so the
/// cap still holds.
fn rotate(path: &Path) {
    let mut rotated = path.as_os_str().to_os_string();
    rotated.push(".1");
    let rotated = PathBuf::from(rotated);
    let _ = std::fs::remove_file(&rotated);
    if std::fs::rename(path, &rotated).is_err() {
        let _ = std::fs::write(path, b"");
    }
}

/// Format a `SystemTime` as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Hand-rolled rather than pulling in `chrono`/`time`: the shell's whole job is
/// to stay small, and this is the only place a wall-clock string is needed.
/// Uses Howard Hinnant's `civil_from_days` algorithm, which is exact for every
/// date this app will ever see.
fn iso8601_utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Days since 1970-01-01 -> (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A unique scratch dir per test (no tempfile dependency in this crate).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "videodubber-logtest-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_are_appended_with_a_timestamp() {
        let dir = scratch("append");
        let mut sink = LogSink::open(&dir, "svc").unwrap();
        sink.write_line("hello");
        sink.write_line("world");
        let body = std::fs::read_to_string(dir.join("svc.log")).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" hello"), "got {:?}", lines[0]);
        assert!(lines[1].ends_with(" world"), "got {:?}", lines[1]);
        // `2026-09-18T…Z ` prefix.
        assert_eq!(&lines[0][4..5], "-");
        assert!(lines[0][..20].ends_with('Z'));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The cap is what keeps a daily-driver install from filling a disk: once
    /// the live file reaches it, it rolls to `.log.1` and the newest output —
    /// the part that explains the crash — keeps being written.
    #[test]
    fn rotates_once_the_cap_is_reached() {
        let dir = scratch("rotate");
        let mut sink = LogSink::open_with_cap(&dir, "svc", 64).unwrap();
        for i in 0..20 {
            sink.write_line(&format!("line {i} ....................."));
        }
        let live = std::fs::read_to_string(dir.join("svc.log")).unwrap();
        let rotated = std::fs::read_to_string(dir.join("svc.log.1")).unwrap();
        assert!(live.contains("line 19"), "newest output must survive");
        assert!(!rotated.is_empty(), "previous generation must be kept");
        assert!(live.len() as u64 <= 64 + 64, "live file stays near the cap");
        // Exactly two generations — never a third.
        assert!(!dir.join("svc.log.2").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Reopening an already-oversized file must rotate before appending, or a
    /// log that grew large in a previous run would never shrink.
    #[test]
    fn rotates_on_open_when_the_existing_file_is_oversized() {
        let dir = scratch("reopen");
        std::fs::write(dir.join("svc.log"), vec![b'x'; 200]).unwrap();
        let mut sink = LogSink::open_with_cap(&dir, "svc", 64).unwrap();
        sink.write_line("fresh");
        assert_eq!(std::fs::metadata(dir.join("svc.log.1")).unwrap().len(), 200);
        assert!(std::fs::read_to_string(dir.join("svc.log"))
            .unwrap()
            .contains("fresh"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn formats_known_instants_as_iso8601_utc() {
        assert_eq!(iso8601_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso8601_utc(UNIX_EPOCH + Duration::from_secs(1_758_153_600)),
            "2025-09-18T00:00:00Z"
        );
        // A leap day, the case a naive 365-day loop gets wrong.
        assert_eq!(
            iso8601_utc(UNIX_EPOCH + Duration::from_secs(1_709_208_296)),
            "2024-02-29T12:04:56Z"
        );
    }
}
