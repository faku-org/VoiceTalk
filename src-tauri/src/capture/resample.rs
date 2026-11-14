//! Interleaved f32 at any rate/channel count -> 16 kHz mono pcm_s16le, in fixed 20 ms frames.
//!
//! Downmix = channel average. Resample = streaming area average (box filter over the input span of each output
//! sample): cheap, any ratio, and enough anti-aliasing for speech STT.

pub const OUT_RATE: u32 = 16_000;
/// 20 ms at 16 kHz.
pub const FRAME_SAMPLES: usize = 320;

pub struct Converter {
    channels: usize,
    /// Input samples per output sample.
    ratio: f64,
    acc: f64,
    filled: f64,
    out: Vec<i16>,
    /// Output samples produced so far (including those already drained into frames).
    total_out: u64,
}

/// Silence is only padded when the stream is more than this far behind real time (event jitter is not a gap).
const PAD_SLACK_SAMPLES: u64 = 1_600; // 100 ms

impl Converter {
    pub fn new(in_rate: u32, channels: usize) -> Self {
        Self {
            channels: channels.max(1),
            ratio: f64::from(in_rate) / f64::from(OUT_RATE),
            acc: 0.0,
            filled: 0.0,
            out: Vec::with_capacity(FRAME_SAMPLES * 2),
            total_out: 0,
        }
    }

    /// WASAPI process loopback delivers nothing while the target is silent. Core's VAD only closes a segment when it
    /// sees silence, so the stream is kept real-time: when it falls more than 100 ms behind `elapsed`, silence fills
    /// the gap. Keeps both channels on the same clock too.
    pub fn pad_to(&mut self, elapsed: std::time::Duration) -> Vec<Vec<u8>> {
        let target = (elapsed.as_secs_f64() * f64::from(OUT_RATE)) as u64;
        if target <= self.total_out + PAD_SLACK_SAMPLES {
            return Vec::new();
        }
        let missing = (target - self.total_out) as usize;
        self.out.extend(std::iter::repeat_n(0_i16, missing));
        self.total_out += missing as u64;
        self.frames()
    }

    fn frames(&mut self) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        while self.out.len() >= FRAME_SAMPLES {
            let bytes: Vec<u8> = self
                .out
                .drain(..FRAME_SAMPLES)
                .flat_map(i16::to_le_bytes)
                .collect();
            frames.push(bytes);
        }
        frames
    }

    /// Feeds interleaved samples; returns every complete 20 ms frame as little-endian bytes (640 B each).
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<Vec<u8>> {
        let ch = self.channels;
        for frame in interleaved.chunks_exact(ch) {
            let x = f64::from(frame.iter().sum::<f32>()) / ch as f64;
            let mut remaining = 1.0_f64;
            loop {
                let need = self.ratio - self.filled;
                if remaining >= need {
                    self.acc += x * need;
                    let v = (self.acc / self.ratio).clamp(-1.0, 1.0);
                    self.out.push((v * f64::from(i16::MAX)).round() as i16);
                    self.total_out += 1;
                    self.acc = 0.0;
                    self.filled = 0.0;
                    remaining -= need;
                    if remaining <= 1e-9 {
                        break;
                    }
                } else {
                    self.acc += x * remaining;
                    self.filled += remaining;
                    break;
                }
            }
        }
        self.frames()
    }
}

/// RMS of a block, both 0..1. Used for the level meters.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    ((sum / samples.len() as f64).sqrt() as f32).min(1.0)
}

/// Little-endian f32 bytes -> samples. Trailing partial samples are dropped.
pub fn f32_from_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f32, secs: f32, channels: usize, amp: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        let mut v = Vec::with_capacity(n * channels);
        for i in 0..n {
            let s = amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin();
            for _ in 0..channels {
                v.push(s);
            }
        }
        v
    }

    fn samples(frames: &[Vec<u8>]) -> Vec<i16> {
        frames
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<u8>>()
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    #[test]
    fn one_second_of_48k_stereo_is_fifty_frames() {
        let mut c = Converter::new(48_000, 2);
        let frames = c.push(&sine(48_000, 440.0, 1.0, 2, 0.5));
        assert_eq!(frames.len(), 50);
        assert!(frames.iter().all(|f| f.len() == FRAME_SAMPLES * 2));
    }

    #[test]
    fn works_for_44k1_and_streams_in_odd_chunks() {
        let input = sine(44_100, 300.0, 1.0, 2, 0.4);
        let mut whole = Converter::new(44_100, 2);
        let a = samples(&whole.push(&input));
        let mut parts = Converter::new(44_100, 2);
        let mut b = Vec::new();
        for chunk in input.chunks(2 * 997) {
            b.extend(samples(&parts.push(chunk)));
        }
        assert_eq!(a, b);
        // 16000 samples +- the partial frame.
        assert!((15_680..=16_000).contains(&a.len()));
    }

    #[test]
    fn preserves_a_low_tone_amplitude() {
        let mut c = Converter::new(48_000, 2);
        let out = samples(&c.push(&sine(48_000, 440.0, 1.0, 2, 0.5)));
        let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap();
        let expected = 0.5 * f32::from(i16::MAX);
        assert!(
            (f32::from(peak) - expected).abs() < expected * 0.05,
            "peak {peak}"
        );
    }

    #[test]
    fn downmix_averages_channels() {
        let mut c = Converter::new(16_000, 2);
        // L = 0.5, R = -0.5 cancels to silence.
        let mut input = Vec::new();
        for _ in 0..FRAME_SAMPLES {
            input.push(0.5);
            input.push(-0.5);
        }
        let out = samples(&c.push(&input));
        assert!(out.iter().all(|s| *s == 0));
    }

    #[test]
    fn a_tone_above_nyquist_is_attenuated() {
        // 12 kHz at 48 kHz folds above the 8 kHz Nyquist of the output: the box filter must knock it down.
        let mut c = Converter::new(48_000, 1);
        let out = samples(&c.push(&sine(48_000, 12_000.0, 1.0, 1, 0.5)));
        let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(f32::from(peak) < 0.25 * f32::from(i16::MAX), "peak {peak}");
    }

    #[test]
    fn clamps_instead_of_wrapping() {
        let mut c = Converter::new(16_000, 1);
        let out = samples(&c.push(&vec![3.0; FRAME_SAMPLES]));
        assert!(out.iter().all(|s| *s == i16::MAX));
    }

    #[test]
    fn pads_silence_when_the_stream_falls_behind() {
        use std::time::Duration;
        let mut c = Converter::new(48_000, 2);
        // Nothing arrived for 1 s: one second of silence (50 frames).
        let frames = c.pad_to(Duration::from_secs(1));
        assert_eq!(frames.len(), 50);
        assert!(samples(&frames).iter().all(|s| *s == 0));
        // Right after, within the slack: nothing more.
        assert!(c.pad_to(Duration::from_millis(1_050)).is_empty());
    }

    #[test]
    fn does_not_pad_a_stream_that_keeps_up() {
        use std::time::Duration;
        let mut c = Converter::new(48_000, 2);
        let frames = c.push(&sine(48_000, 440.0, 1.0, 2, 0.5));
        assert_eq!(frames.len(), 50);
        assert!(c.pad_to(Duration::from_millis(1_050)).is_empty());
    }

    #[test]
    fn level_is_rms() {
        assert_eq!(level(&[]), 0.0);
        assert!((level(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn decodes_f32_bytes() {
        let bytes: Vec<u8> = [0.25_f32, -1.0].iter().flat_map(|f| f.to_le_bytes()).collect();
        assert_eq!(f32_from_bytes(&bytes), vec![0.25, -1.0]);
        assert_eq!(f32_from_bytes(&bytes[..6]), vec![0.25]);
    }
}
