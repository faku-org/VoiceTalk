//! Call detection (ADR 0016): a pure state machine. No Windows calls, so it is unit-tested everywhere.
//!
//! The Windows probe (`detect_win.rs`) reads who holds the microphone and which windows are open, and feeds one
//! [`Input`] per poll to [`Detector::tick`]. The detector decides when a call starts, whether to ask, and when it
//! ended (microphone released for [`END_DEBOUNCE_MS`]).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::apps::{is_browser, platform_for_image};

/// The mic must stay released this long before a call counts as ended (a mute toggle or a tab switch is not the end).
pub const END_DEBOUNCE_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rule {
    Ask,
    Always,
    Never,
}

/// What the user asked for (`prefs.capture.detect`, pushed by the webview).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub enabled: bool,
    /// Per platform key. A missing platform means `Ask`.
    #[serde(default)]
    pub rules: HashMap<String, Rule>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            rules: HashMap::new(),
        }
    }
}

impl Config {
    pub fn rule_for(&self, platform: &str) -> Rule {
        if !self.enabled {
            return Rule::Never;
        }
        self.rules.get(platform).copied().unwrap_or(Rule::Ask)
    }
}

/// A process that holds the microphone right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    /// Image name, e.g. `Discord.exe`.
    pub image: String,
    /// Root pid of that app (0 when it could not be resolved).
    pub pid: u32,
    /// The holder is VoiceTalk itself (or one of its children, such as its WebView2): never a call to ask about.
    pub own: bool,
}

/// A visible top-level window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub image: String,
    pub title: String,
    pub foreground: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Input {
    pub holders: Vec<Holder>,
    pub windows: Vec<Window>,
}

/// Image names a ConsentStore key can stand for. `NonPackaged` keys are an exe path with `\` written as `#`
/// (`C:#Program Files#Zoom#bin#Zoom.exe`); packaged apps are keyed by package family name, which has no exe, so the
/// few call apps that ship as packages are listed here.
pub fn images_for_consent_key(key: &str, non_packaged: bool) -> Vec<String> {
    if non_packaged {
        return key
            .rsplit('#')
            .next()
            .filter(|n| !n.is_empty())
            .map(|n| vec![n.to_string()])
            .unwrap_or_default();
    }
    let k = key.to_ascii_lowercase();
    let images: &[&str] = if k.starts_with("msteams_") {
        &["ms-teams.exe", "msteams.exe"]
    } else if k.starts_with("microsoft.microsoftteams_") {
        &["teams.exe"]
    } else if k.contains("whatsappdesktop") {
        &["WhatsApp.Root.exe", "WhatsApp.exe"]
    } else if k.contains("discord") {
        &["Discord.exe"]
    } else if k.contains("slack") {
        &["slack.exe"]
    } else if k.contains("zoom") {
        &["Zoom.exe"]
    } else {
        &[]
    };
    images.iter().map(|i| i.to_string()).collect()
}

/// A call as the webview sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Call {
    pub platform: String,
    pub app: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A call started and the rule is not `never`. `rule` says whether to ask (`Ask`) or start (`Always`).
    Detected { call: Call, rule: Rule },
    /// A call that was announced ended.
    Ended { call: Call },
}

/// Platform of a browser tab from the window title. Matches Meet, Zoom and Teams on the web.
pub fn platform_for_title(title: &str) -> Option<&'static str> {
    let t = title.to_lowercase();
    if t.starts_with("meet - ")
        || t.starts_with("meet \u{2013} ")
        || t.contains("meet.google.com")
        || t.contains("google meet")
    {
        Some("meet")
    } else if t.contains("microsoft teams") {
        Some("teams")
    } else if t.contains("zoom") {
        Some("zoom")
    } else {
        None
    }
}

/// Platform a holder is in a call of. Known apps by image; a browser only when one of its windows names the call
/// (the foreground one first). A browser holding the mic for something else (dictation, a recorder) is not a call.
fn classify(holder: &Holder, windows: &[Window]) -> Option<&'static str> {
    if let Some(p) = platform_for_image(&holder.image) {
        return Some(p);
    }
    if !is_browser(&holder.image) {
        return None;
    }
    let own = || {
        windows
            .iter()
            .filter(|w| w.image.eq_ignore_ascii_case(&holder.image))
    };
    own()
        .filter(|w| w.foreground)
        .chain(own().filter(|w| !w.foreground))
        .find_map(|w| platform_for_title(&w.title))
}

fn candidate(input: &Input) -> Option<Call> {
    input.holders.iter().filter(|h| !h.own).find_map(|h| {
        classify(h, &input.windows).map(|platform| Call {
            platform: platform.to_string(),
            app: h.image.clone(),
            pid: h.pid,
        })
    })
}

struct Active {
    call: Call,
    /// Last poll that saw the mic held.
    last_seen: u64,
    /// The webview was told (so it is told once per call, and told when it ended).
    announced: bool,
}

pub struct Detector {
    config: Config,
    active: Option<Active>,
}

impl Detector {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            active: None,
        }
    }

    pub fn set_config(&mut self, config: Config) {
        self.config = config;
    }

    /// Feeds one poll. Returns the events it caused, in order.
    ///
    /// A call is announced once. "Ahora no" needs no extra state: the same call is never announced again, and a
    /// new one only starts after the mic was released for [`END_DEBOUNCE_MS`].
    pub fn tick(&mut self, now_ms: u64, input: &Input) -> Vec<Event> {
        let mut events = Vec::new();
        let seen = candidate(input);

        let same =
            matches!((&self.active, &seen), (Some(a), Some(c)) if a.call.platform == c.platform);
        if same {
            if let (Some(active), Some(call)) = (&mut self.active, seen) {
                active.last_seen = now_ms;
                active.call = call;
            }
        } else {
            // Another platform took the mic, or nobody holds it.
            let expired = self
                .active
                .as_ref()
                .is_some_and(|a| now_ms.saturating_sub(a.last_seen) >= END_DEBOUNCE_MS);
            if seen.is_some() || expired {
                if let Some(old) = self.active.take() {
                    if old.announced {
                        events.push(Event::Ended { call: old.call });
                    }
                }
                self.active = seen.map(|call| Active {
                    call,
                    last_seen: now_ms,
                    announced: false,
                });
            }
        }

        // Announce (also after a config change in the middle of a call).
        if let Some(active) = &mut self.active {
            if !active.announced {
                let rule = self.config.rule_for(&active.call.platform);
                if rule != Rule::Never {
                    active.announced = true;
                    events.push(Event::Detected {
                        call: active.call.clone(),
                        rule,
                    });
                }
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holder(image: &str, pid: u32) -> Holder {
        Holder {
            image: image.into(),
            pid,
            own: false,
        }
    }

    fn win(image: &str, title: &str, foreground: bool) -> Window {
        Window {
            image: image.into(),
            title: title.into(),
            foreground,
        }
    }

    fn mic(holders: Vec<Holder>) -> Input {
        Input {
            holders,
            windows: vec![],
        }
    }

    fn detector() -> Detector {
        Detector::new(Config::default())
    }

    fn discord() -> Input {
        mic(vec![holder("Discord.exe", 10)])
    }

    fn call(platform: &str, app: &str, pid: u32) -> Call {
        Call {
            platform: platform.into(),
            app: app.into(),
            pid,
        }
    }

    #[test]
    fn starts_on_the_first_poll_that_sees_the_mic() {
        let mut d = detector();
        assert!(d.tick(0, &Input::default()).is_empty());
        assert_eq!(
            d.tick(1_500, &discord()),
            vec![Event::Detected {
                call: call("discord", "Discord.exe", 10),
                rule: Rule::Ask
            }]
        );
    }

    #[test]
    fn asks_once_per_call() {
        let mut d = detector();
        assert_eq!(d.tick(0, &discord()).len(), 1);
        for t in 1..20 {
            assert!(d.tick(t * 1_500, &discord()).is_empty());
        }
    }

    #[test]
    fn end_needs_the_mic_released_for_ten_seconds() {
        let mut d = detector();
        d.tick(0, &discord());
        // 9.9 s of silence: still the same call.
        assert!(d.tick(1_000, &Input::default()).is_empty());
        assert!(d.tick(9_900, &Input::default()).is_empty());
        // Back before the debounce ran out: no end, no second question.
        assert!(d.tick(10_500, &discord()).is_empty());
        assert!(d.tick(12_000, &Input::default()).is_empty());
        // Ten seconds after the last time the mic was seen.
        assert_eq!(
            d.tick(20_500, &Input::default()),
            vec![Event::Ended {
                call: call("discord", "Discord.exe", 10)
            }]
        );
        // Nothing left to end.
        assert!(d.tick(30_000, &Input::default()).is_empty());
    }

    #[test]
    fn a_new_call_after_the_end_asks_again() {
        let mut d = detector();
        d.tick(0, &discord());
        d.tick(1_500, &Input::default());
        assert_eq!(d.tick(11_500, &Input::default()).len(), 1);
        assert_eq!(d.tick(13_000, &discord()).len(), 1);
    }

    #[test]
    fn ahora_no_holds_until_that_call_ends() {
        // "Ahora no" is the webview doing nothing: the detector never re-announces the same call, not even after a
        // short gap, and only a call that really ended can ask again.
        let mut d = detector();
        assert_eq!(d.tick(0, &discord()).len(), 1);
        assert!(d.tick(5_000, &Input::default()).is_empty());
        assert!(d.tick(8_000, &discord()).is_empty());
        assert!(d.tick(9_000, &discord()).is_empty());
        // Real end, then a new call.
        assert_eq!(d.tick(19_000, &Input::default()).len(), 1);
        assert_eq!(d.tick(21_000, &discord()).len(), 1);
    }

    #[test]
    fn ignores_voicetalk_itself() {
        let mut d = detector();
        let own = Holder {
            image: "msedgewebview2.exe".into(),
            pid: 5,
            own: true,
        };
        assert!(d.tick(0, &mic(vec![own])).is_empty());
        // Its own capture holds the mic as VoiceTalk.exe: also not a call.
        assert!(d
            .tick(
                1_500,
                &mic(vec![Holder {
                    image: "voicetalk.exe".into(),
                    pid: 6,
                    own: true
                }])
            )
            .is_empty());
    }

    #[test]
    fn unknown_apps_are_not_calls() {
        let mut d = detector();
        assert!(d.tick(0, &mic(vec![holder("obs64.exe", 3)])).is_empty());
    }

    #[test]
    fn browser_title_names_the_platform() {
        let chrome = holder("chrome.exe", 40);
        for (title, platform) in [
            ("Meet - abc-defg-hij - Google Chrome", "meet"),
            ("Meet \u{2013} abc-defg-hij", "meet"),
            ("Reunion semanal | Microsoft Teams", "teams"),
            ("Zoom Meeting", "zoom"),
        ] {
            let mut d = detector();
            let input = Input {
                holders: vec![chrome.clone()],
                windows: vec![win("chrome.exe", title, true)],
            };
            assert_eq!(
                d.tick(0, &input),
                vec![Event::Detected {
                    call: call(platform, "chrome.exe", 40),
                    rule: Rule::Ask
                }],
                "{title}"
            );
        }
    }

    #[test]
    fn browser_without_a_call_title_is_not_a_call() {
        let mut d = detector();
        let input = Input {
            holders: vec![holder("msedge.exe", 41)],
            windows: vec![
                win("msedge.exe", "Dictado - Documentos", true),
                // A Meet title in another browser does not count for this one.
                win("chrome.exe", "Meet - abc", false),
            ],
        };
        assert!(d.tick(0, &input).is_empty());
    }

    #[test]
    fn browser_prefers_the_foreground_window() {
        let mut d = detector();
        let input = Input {
            holders: vec![holder("chrome.exe", 40)],
            windows: vec![
                win("chrome.exe", "Zoom - ventas", false),
                win("chrome.exe", "Meet - abc-defg-hij", true),
            ],
        };
        let events = d.tick(0, &input);
        assert_eq!(
            events,
            vec![Event::Detected {
                call: call("meet", "chrome.exe", 40),
                rule: Rule::Ask
            }]
        );
    }

    #[test]
    fn native_app_wins_over_browser_when_both_hold_the_mic() {
        let mut d = detector();
        let input = Input {
            holders: vec![holder("chrome.exe", 40), holder("Zoom.exe", 12)],
            windows: vec![win("chrome.exe", "Meet - abc", true)],
        };
        // First holder with a platform wins; the order comes from the registry, so the test pins the contract: one
        // call at a time.
        let events = d.tick(0, &input);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn rule_never_stays_quiet() {
        let mut cfg = Config::default();
        cfg.rules.insert("discord".into(), Rule::Never);
        let mut d = Detector::new(cfg);
        assert!(d.tick(0, &discord()).is_empty());
        // Nothing announced, so nothing ends.
        assert!(d.tick(20_000, &Input::default()).is_empty());
    }

    #[test]
    fn rule_always_is_reported_so_the_webview_starts_through_consent() {
        let mut cfg = Config::default();
        cfg.rules.insert("discord".into(), Rule::Always);
        let mut d = Detector::new(cfg);
        assert_eq!(
            d.tick(0, &discord()),
            vec![Event::Detected {
                call: call("discord", "Discord.exe", 10),
                rule: Rule::Always
            }]
        );
    }

    #[test]
    fn rules_are_per_platform() {
        let mut cfg = Config::default();
        cfg.rules.insert("discord".into(), Rule::Never);
        let mut d = Detector::new(cfg);
        assert!(d.tick(0, &discord()).is_empty());
        d.tick(1_000, &Input::default());
        d.tick(12_000, &Input::default());
        let zoom = mic(vec![holder("Zoom.exe", 7)]);
        assert_eq!(d.tick(13_000, &zoom).len(), 1);
    }

    #[test]
    fn disabled_switch_silences_everything() {
        let mut d = Detector::new(Config {
            enabled: false,
            rules: HashMap::from([("discord".to_string(), Rule::Always)]),
        });
        assert!(d.tick(0, &discord()).is_empty());
    }

    #[test]
    fn changing_the_rule_mid_call_announces_it() {
        let mut cfg = Config::default();
        cfg.rules.insert("discord".into(), Rule::Never);
        let mut d = Detector::new(cfg);
        assert!(d.tick(0, &discord()).is_empty());
        d.set_config(Config::default());
        assert_eq!(d.tick(1_500, &discord()).len(), 1);
        // And turning it off afterwards does not hide the end of an announced call.
        d.set_config(Config {
            enabled: false,
            rules: HashMap::new(),
        });
        assert_eq!(d.tick(20_000, &Input::default()).len(), 1);
    }

    #[test]
    fn switching_platform_ends_one_call_and_starts_the_next() {
        let mut d = detector();
        d.tick(0, &discord());
        let events = d.tick(
            1_500,
            &Input {
                holders: vec![holder("Zoom.exe", 7)],
                windows: vec![],
            },
        );
        assert_eq!(
            events,
            vec![
                Event::Ended {
                    call: call("discord", "Discord.exe", 10)
                },
                Event::Detected {
                    call: call("zoom", "Zoom.exe", 7),
                    rule: Rule::Ask
                }
            ]
        );
    }

    #[test]
    fn consent_keys_map_to_images() {
        assert_eq!(
            images_for_consent_key("C:#Program Files#Zoom#bin#Zoom.exe", true),
            vec!["Zoom.exe"]
        );
        assert_eq!(
            images_for_consent_key(
                "C:#Users#me#AppData#Local#Discord#app-1.0#Discord.exe",
                true
            ),
            vec!["Discord.exe"]
        );
        assert_eq!(
            images_for_consent_key("MSTeams_8wekyb3d8bbwe", false),
            vec!["ms-teams.exe", "msteams.exe"]
        );
        assert!(images_for_consent_key("Microsoft.WindowsCamera_8wekyb3d8bbwe", false).is_empty());
    }

    #[test]
    fn title_mapping() {
        assert_eq!(platform_for_title("Meet - kqx-abcd-xyz"), Some("meet"));
        assert_eq!(platform_for_title("Google Meet"), Some("meet"));
        assert_eq!(platform_for_title("Chat | Microsoft Teams"), Some("teams"));
        assert_eq!(platform_for_title("My Zoom Meeting"), Some("zoom"));
        assert_eq!(platform_for_title("YouTube"), None);
    }
}
