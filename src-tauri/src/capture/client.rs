//! Sync WebSocket client to core `WS /capture` (ADR 0009). Runs in its own thread and owns the socket.
//!
//! Protocol (see `core/src/capture/protocol.ts`): text JSON `start` first and `stop` last; binary frames are one
//! channel byte (0 remote, 1 mic) followed by pcm_s16le 16 kHz mono. Core answers `started`, `error`, `ended`.

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::{client::client, Message, WebSocket};

pub const CHANNEL_REMOTE: u8 = 0;
pub const CHANNEL_MIC: u8 = 1;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// Core drains for up to 10 s on stop (ADR 0009); wait a bit longer than that.
const ENDED_TIMEOUT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(20);

pub type Socket = WebSocket<TcpStream>;
pub type Frame = (u8, Vec<u8>);

/// What the user sees when a capture cannot start or is cut short. `code` is core's code, or `connect`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CaptureError {
    pub code: String,
    pub message: String,
}

impl CaptureError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// `http://127.0.0.1:4100` -> `127.0.0.1:4100`.
pub fn host_port(core_url: &str) -> &str {
    core_url
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://")
}

/// Binary frame for core: channel tag + pcm.
pub fn frame_bytes(channel: u8, pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() + 1);
    out.push(channel);
    out.extend_from_slice(pcm);
    out
}

/// The `start` message.
pub fn start_message(source: &str, app: Option<&str>) -> String {
    let mut v = json!({ "type": "start", "source": source });
    if let Some(app) = app.filter(|a| !a.is_empty()) {
        v["app"] = Value::String(app.to_string());
    }
    v.to_string()
}

/// Core's JSON replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Started { call_id: String },
    Error(CaptureError),
    Ended { utterances: u64 },
    Other,
}

pub fn parse_reply(text: &str) -> Reply {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Reply::Other;
    };
    match v.get("type").and_then(Value::as_str) {
        Some("started") => Reply::Started {
            call_id: v
                .get("callId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        Some("error") => Reply::Error(CaptureError::new(
            v.get("code").and_then(Value::as_str).unwrap_or("error"),
            v.get("message").and_then(Value::as_str).unwrap_or(""),
        )),
        Some("ended") => Reply::Ended {
            utterances: v.get("utterances").and_then(Value::as_u64).unwrap_or(0),
        },
        _ => Reply::Other,
    }
}

fn is_timeout(err: &tungstenite::Error) -> bool {
    matches!(
        err,
        tungstenite::Error::Io(e)
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    )
}

/// Reads one text reply, waiting up to `timeout`. `Ok(None)` on timeout.
fn read_reply(ws: &mut Socket, timeout: Duration) -> Result<Option<Reply>, CaptureError> {
    let deadline = Instant::now() + timeout;
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => return Ok(Some(parse_reply(t.as_str()))),
            Ok(Message::Close(_)) => {
                return Err(CaptureError::new("connect", "core closed the connection"))
            }
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {
                if Instant::now() >= deadline {
                    return Ok(None);
                }
            }
            Err(e) => return Err(CaptureError::new("connect", e.to_string())),
        }
    }
}

/// Connects, sends `start` and waits for `started`. Returns the socket and the call id.
pub fn connect(
    core_url: &str,
    source: &str,
    app: Option<&str>,
) -> Result<(Socket, String), CaptureError> {
    let addr = host_port(core_url);
    let sock_addr = addr
        .to_socket_addrs()
        .map_err(|e| CaptureError::new("connect", format!("bad core address {addr}: {e}")))?
        .next()
        .ok_or_else(|| CaptureError::new("connect", format!("bad core address {addr}")))?;
    let stream = TcpStream::connect_timeout(&sock_addr, CONNECT_TIMEOUT)
        .map_err(|e| CaptureError::new("connect", format!("core is not reachable: {e}")))?;
    let _ = stream.set_nodelay(true);
    let url = format!("ws://{addr}/capture");
    let (mut ws, _) = client(url.as_str(), stream).map_err(|e| match e {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp))
            if resp.status().as_u16() == 409 =>
        {
            CaptureError::new("busy", "Ya hay una llamada o una captura en curso.")
        }
        other => CaptureError::new("connect", other.to_string()),
    })?;
    ws.get_ref()
        .set_read_timeout(Some(POLL))
        .map_err(|e| CaptureError::new("connect", e.to_string()))?;
    ws.send(Message::text(start_message(source, app)))
        .map_err(|e| CaptureError::new("connect", e.to_string()))?;
    match read_reply(&mut ws, REPLY_TIMEOUT)? {
        Some(Reply::Started { call_id }) => Ok((ws, call_id)),
        Some(Reply::Error(e)) => Err(e),
        Some(_) | None => Err(CaptureError::new("connect", "core did not confirm the capture")),
    }
}

/// How a running session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Core confirmed `ended` after our `stop`.
    Ended { utterances: u64 },
    /// Core or the socket failed mid-capture.
    Failed(CaptureError),
}

/// Pumps frames to core until every producer is gone (`rx` disconnects), then sends `stop` and waits for `ended`.
/// A core `error` or a dead socket ends it immediately and raises `abort` so the capture threads stop too.
pub fn run(mut ws: Socket, rx: Receiver<Frame>, abort: Arc<AtomicBool>) -> Outcome {
    let failed = |abort: &AtomicBool, e: CaptureError| {
        abort.store(true, Ordering::SeqCst);
        Outcome::Failed(e)
    };
    loop {
        match rx.recv_timeout(POLL) {
            Ok((channel, pcm)) => {
                if let Err(e) = ws.send(Message::binary(frame_bytes(channel, &pcm))) {
                    return failed(&abort, CaptureError::new("connect", e.to_string()));
                }
                // Drain a burst without waiting.
                for _ in 0..64 {
                    let Ok((channel, pcm)) = rx.try_recv() else {
                        break;
                    };
                    if let Err(e) = ws.send(Message::binary(frame_bytes(channel, &pcm))) {
                        return failed(&abort, CaptureError::new("connect", e.to_string()));
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Reply::Error(e) = parse_reply(t.as_str()) {
                    return failed(&abort, e);
                }
            }
            Ok(Message::Close(_)) => {
                return failed(&abort, CaptureError::new("connect", "core closed the connection"))
            }
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(e) => return failed(&abort, CaptureError::new("connect", e.to_string())),
        }
    }
    if let Err(e) = ws.send(Message::text(json!({ "type": "stop" }).to_string())) {
        return Outcome::Failed(CaptureError::new("connect", e.to_string()));
    }
    let deadline = Instant::now() + ENDED_TIMEOUT;
    while Instant::now() < deadline {
        match read_reply(&mut ws, POLL) {
            Ok(Some(Reply::Ended { utterances })) => {
                let _ = ws.close(None);
                return Outcome::Ended { utterances };
            }
            Ok(Some(Reply::Error(e))) => return Outcome::Failed(e),
            Ok(_) => {}
            Err(e) => return Outcome::Failed(e),
        }
    }
    Outcome::Failed(CaptureError::new("connect", "core did not confirm the end"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn host_port_strips_scheme() {
        assert_eq!(host_port("http://127.0.0.1:4100"), "127.0.0.1:4100");
        assert_eq!(host_port("http://127.0.0.1:4100/"), "127.0.0.1:4100");
    }

    #[test]
    fn frames_carry_the_channel_tag() {
        assert_eq!(frame_bytes(CHANNEL_MIC, &[1, 2]), vec![1, 1, 2]);
        assert_eq!(frame_bytes(CHANNEL_REMOTE, &[]), vec![0]);
    }

    #[test]
    fn start_message_shape() {
        let v: Value = serde_json::from_str(&start_message("discord", Some("Discord.exe"))).unwrap();
        assert_eq!(v["type"], "start");
        assert_eq!(v["source"], "discord");
        assert_eq!(v["app"], "Discord.exe");
        let v: Value = serde_json::from_str(&start_message("other", None)).unwrap();
        assert!(v.get("app").is_none());
    }

    #[test]
    fn parses_core_replies() {
        assert_eq!(
            parse_reply(r#"{"type":"started","callId":"abc"}"#),
            Reply::Started { call_id: "abc".into() }
        );
        assert_eq!(
            parse_reply(r#"{"type":"error","code":"consent","message":"m"}"#),
            Reply::Error(CaptureError { code: "consent".into(), message: "m".into() })
        );
        assert_eq!(
            parse_reply(r#"{"type":"ended","callId":"abc","utterances":3}"#),
            Reply::Ended { utterances: 3 }
        );
        assert_eq!(parse_reply("nope"), Reply::Other);
    }

    /// A throwaway server that speaks just enough of the core protocol.
    fn fake_core(reply_to_start: &'static str) -> (String, thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let h = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let mut binary = Vec::new();
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) => {
                        let v: Value = serde_json::from_str(t.as_str()).unwrap();
                        if v["type"] == "start" {
                            ws.send(Message::text(reply_to_start)).unwrap();
                            if reply_to_start.contains("error") {
                                return binary;
                            }
                        } else if v["type"] == "stop" {
                            ws.send(Message::text(
                                r#"{"type":"ended","callId":"c1","utterances":2}"#,
                            ))
                            .unwrap();
                            return binary;
                        }
                    }
                    Ok(Message::Binary(b)) => binary.push(b.to_vec()),
                    Ok(_) => {}
                    Err(_) => return binary,
                }
            }
        });
        (url, h)
    }

    #[test]
    fn full_session_against_a_fake_core() {
        let (url, server) = fake_core(r#"{"type":"started","callId":"c1"}"#);
        let (ws, call_id) = connect(&url, "zoom", Some("Zoom.exe")).unwrap();
        assert_eq!(call_id, "c1");
        let (tx, rx) = mpsc::channel();
        let abort = Arc::new(AtomicBool::new(false));
        let a2 = abort.clone();
        let pump = thread::spawn(move || run(ws, rx, a2));
        tx.send((CHANNEL_REMOTE, vec![9; 640])).unwrap();
        tx.send((CHANNEL_MIC, vec![7; 640])).unwrap();
        drop(tx);
        assert_eq!(pump.join().unwrap(), Outcome::Ended { utterances: 2 });
        assert!(!abort.load(Ordering::SeqCst));
        let got = server.join().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0][0], CHANNEL_REMOTE);
        assert_eq!(got[0].len(), 641);
        assert_eq!(got[1][0], CHANNEL_MIC);
    }

    #[test]
    fn start_errors_surface_with_their_code() {
        let (url, server) =
            fake_core(r#"{"type":"error","code":"consent","message":"Falta el aviso"}"#);
        let err = connect(&url, "zoom", None).err().unwrap();
        assert_eq!(err.code, "consent");
        assert_eq!(err.message, "Falta el aviso");
        server.join().unwrap();
    }

    #[test]
    fn unreachable_core_is_a_connect_error() {
        let err = connect("http://127.0.0.1:1", "zoom", None).err().unwrap();
        assert_eq!(err.code, "connect");
    }
}
