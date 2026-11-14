//! Headless capture probe: captures `<pid>` (and its tree) for `<seconds>` against a running core and prints what
//! core answers. Used to verify ADR 0009 end to end without the UI.
//!
//! ```text
//! cargo run --manifest-path src-tauri/Cargo.toml --example capture_probe -- <core_url> <pid> <seconds> [platform] [mic]
//! ```

#[cfg(windows)]
fn main() {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;
    use std::time::Duration;
    use voicetalk_lib::capture::client::{self, Outcome, CHANNEL_MIC, CHANNEL_REMOTE};
    use voicetalk_lib::capture::win::{self, Target};

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: capture_probe <core_url> <pid> <seconds> [platform] [mic]");
        std::process::exit(2);
    }
    let (core_url, pid, secs) = (&args[1], &args[2], &args[3]);
    let pid: u32 = pid.parse().expect("pid");
    let secs: u64 = secs.parse().expect("seconds");
    let platform = args.get(4).map(String::as_str).unwrap_or("other");
    let mic = args.get(5).is_some_and(|m| m == "mic");

    let (ws, call_id) = match client::connect(core_url, platform, Some("probe")) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("start failed: {e}");
            std::process::exit(1);
        }
    };
    println!("started callId={call_id}");
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = sync_channel(512);
    let pump = {
        let stop = stop.clone();
        std::thread::spawn(move || client::run(ws, rx, stop))
    };
    let meter = Arc::new(AtomicU32::new(0));
    let mut caps = vec![win::spawn(
        Target::Process(pid),
        CHANNEL_REMOTE,
        stop.clone(),
        tx.clone(),
        meter.clone(),
    )];
    if mic {
        caps.push(win::spawn(
            Target::Mic,
            CHANNEL_MIC,
            stop.clone(),
            tx.clone(),
            Arc::new(AtomicU32::new(0)),
        ));
    }
    drop(tx);
    for c in &caps {
        match win::wait_ready(c, Duration::from_secs(5)) {
            Ok(()) => println!("capture device open"),
            Err(e) => {
                eprintln!("capture failed: {e}");
                stop.store(true, Ordering::SeqCst);
            }
        }
    }
    let mut peak = 0.0_f32;
    for _ in 0..secs * 10 {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
        peak = peak.max(win::take_level(&meter));
    }
    println!("remote peak level over {secs}s: {peak:.3}");
    stop.store(true, Ordering::SeqCst);
    for c in caps {
        let _ = c.thread.join();
    }
    match pump.join().expect("pump") {
        Outcome::Ended { utterances } => println!("ended utterances={utterances}"),
        Outcome::Failed(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("capture_probe is Windows-only");
}
