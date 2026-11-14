//! Call-app recognition. Pure logic (no Windows calls) so it is unit-tested everywhere.
//!
//! Platform keys are shared with core (`core/src/capture/platforms.ts`): discord, teams, zoom, slack, whatsapp,
//! meet, other.

use std::collections::HashMap;

/// A running process as seen in a Toolhelp snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// Image name, e.g. `Discord.exe`.
    pub name: String,
}

/// Platform key for an image name, or `None` when it is not a known call app.
/// Browsers map to `meet` only through [`is_browser`]: the audio session alone cannot tell a Meet tab from a video.
pub fn platform_for_image(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "discord.exe" | "discordptb.exe" | "discordcanary.exe" => Some("discord"),
        "ms-teams.exe" | "teams.exe" | "msteams.exe" => Some("teams"),
        "zoom.exe" | "zoom.us.exe" => Some("zoom"),
        "slack.exe" => Some("slack"),
        "whatsapp.exe" | "whatsapp.root.exe" => Some("whatsapp"),
        _ => None,
    }
}

pub fn is_browser(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe" | "opera.exe" | "vivaldi.exe"
    )
}

/// Platform key to use for a process: a known app, `meet` for a browser (the user picked it as the call source),
/// `other` for anything else.
pub fn platform_key(name: &str) -> &'static str {
    if let Some(key) = platform_for_image(name) {
        key
    } else if is_browser(name) {
        "meet"
    } else {
        "other"
    }
}

/// Root of the process tree for `pid`: walks the parent chain while the parent has the same image name.
/// Electron apps and browsers play audio from child processes; capturing the root with the tree included gets all
/// of them. Cycles (pid reuse) are cut by a visited set.
pub fn root_pid(procs: &[Proc], pid: u32) -> u32 {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let Some(mut cur) = by_pid.get(&pid).copied() else {
        return pid;
    };
    let mut seen = vec![cur.pid];
    while let Some(parent) = by_pid.get(&cur.parent).copied() {
        if !parent.name.eq_ignore_ascii_case(&cur.name) || seen.contains(&parent.pid) {
            break;
        }
        seen.push(parent.pid);
        cur = parent;
    }
    cur.pid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str) -> Proc {
        Proc {
            pid,
            parent,
            name: name.into(),
        }
    }

    #[test]
    fn recognises_call_apps() {
        assert_eq!(platform_for_image("Discord.exe"), Some("discord"));
        assert_eq!(platform_for_image("ms-teams.exe"), Some("teams"));
        assert_eq!(platform_for_image("Zoom.exe"), Some("zoom"));
        assert_eq!(platform_for_image("slack.exe"), Some("slack"));
        assert_eq!(platform_for_image("WhatsApp.exe"), Some("whatsapp"));
        assert_eq!(platform_for_image("notepad.exe"), None);
    }

    #[test]
    fn browsers_are_meet_and_the_rest_is_other() {
        assert_eq!(platform_key("chrome.exe"), "meet");
        assert_eq!(platform_key("MSEdge.exe"), "meet");
        assert_eq!(platform_key("vlc.exe"), "other");
        assert_eq!(platform_key("Discord.exe"), "discord");
    }

    #[test]
    fn root_walks_up_through_same_image_only() {
        let procs = [
            p(1, 0, "explorer.exe"),
            p(10, 1, "Discord.exe"),
            p(11, 10, "Discord.exe"),
            p(12, 11, "Discord.exe"),
        ];
        assert_eq!(root_pid(&procs, 12), 10);
        assert_eq!(root_pid(&procs, 10), 10);
    }

    #[test]
    fn root_of_unknown_pid_is_itself() {
        assert_eq!(root_pid(&[], 77), 77);
    }

    #[test]
    fn root_survives_a_parent_cycle() {
        let procs = [p(1, 2, "a.exe"), p(2, 1, "a.exe")];
        let r = root_pid(&procs, 1);
        assert!(r == 1 || r == 2);
    }
}
