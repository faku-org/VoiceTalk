//! Native call mic (ADR 0014): echo cancellation against the system loopback, then RNNoise, then 16 kHz s16 frames.
//!
//! The mic is captured at 48 kHz mono-equivalent; the render loopback of the default output device is the far-end
//! reference. Both run at 10 ms blocks (480 samples), the unit of WebRTC AEC3 (`sonora`) and of RNNoise
//! (`nnnoiseless`). Order matters: AEC3 first (it needs the untouched mic), RNNoise second (it removes what is left),
//! then the same [`Converter`] the rest of the capture code uses.

use std::collections::VecDeque;

use nnnoiseless::DenoiseState;
use sonora::config::{EchoCanceller, HighPassFilter};
use sonora::{AudioProcessing, Config, StreamConfig};

use super::resample::Converter;

pub const RATE: u32 = 48_000;
/// 10 ms at 48 kHz: AEC3 block and RNNoise frame.
pub const BLOCK: usize = 480;
/// RNNoise works on i16-scaled floats.
const PCM_SCALE: f32 = 32_768.0;
/// Far-end audio older than this is dropped: it can no longer be the echo of anything the mic hears now.
const MAX_FAR_SAMPLES: usize = RATE as usize * 3 / 10;

/// Interleaved f32 -> mono by channel average.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    interleaved
        .chunks_exact(ch)
        .map(|f| f.iter().sum::<f32>() / ch as f32)
        .collect()
}

pub struct MicPipeline {
    apm: AudioProcessing,
    denoise: Box<DenoiseState<'static>>,
    conv: Converter,
    far: VecDeque<f32>,
    near: Vec<f32>,
    /// Blocks processed; the first RNNoise block is a fade-in and is dropped.
    blocks: u64,
    /// Reference blocks that carried real audio, for the "is the loopback alive" counter.
    far_blocks_active: u64,
    rnnoise: bool,
}

impl MicPipeline {
    /// `rnnoise = false` keeps only AEC3 (used by tests that measure echo cancellation on its own).
    pub fn new(rnnoise: bool) -> Self {
        let stream = StreamConfig::new(RATE, 1);
        let config = Config {
            echo_canceller: Some(EchoCanceller::default()),
            high_pass_filter: Some(HighPassFilter::default()),
            // Noise suppression is RNNoise's job: two suppressors in series pump the voice.
            noise_suppression: None,
            ..Default::default()
        };
        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .build();
        Self {
            apm,
            denoise: DenoiseState::new(),
            conv: Converter::new(RATE, 1),
            far: VecDeque::new(),
            near: Vec::new(),
            blocks: 0,
            far_blocks_active: 0,
            rnnoise,
        }
    }

    /// Far-end (system loopback) samples, mono 48 kHz.
    pub fn push_far(&mut self, mono: &[f32]) {
        self.far.extend(mono.iter().copied());
        if self.far.len() > MAX_FAR_SAMPLES {
            let drop = self.far.len() - MAX_FAR_SAMPLES;
            self.far.drain(..drop);
        }
    }

    /// Echo-cancelled block for one near-end block, consuming the matching far-end block (silence if the loopback
    /// delivered nothing, which is what it does while the system is quiet).
    pub fn aec_block(&mut self, near: &[f32]) -> [f32; BLOCK] {
        debug_assert_eq!(near.len(), BLOCK);
        let mut far = [0.0_f32; BLOCK];
        let mut active = false;
        for slot in far.iter_mut() {
            if let Some(v) = self.far.pop_front() {
                *slot = v;
                active |= v != 0.0;
            }
        }
        if active {
            self.far_blocks_active += 1;
        }
        let mut far_out = [0.0_f32; BLOCK];
        // Both calls only fail on a wrong frame size, which the constants rule out.
        let _ = self
            .apm
            .process_render_f32(&[&far[..]], &mut [&mut far_out[..]]);
        let mut out = [0.0_f32; BLOCK];
        let _ = self.apm.process_capture_f32(&[near], &mut [&mut out[..]]);
        out
    }

    /// Near-end (mic) samples, mono 48 kHz, any length. Returns every complete 20 ms frame (640 B of 16 kHz s16le).
    pub fn push_near(&mut self, mono: &[f32]) -> Vec<Vec<u8>> {
        self.near.extend_from_slice(mono);
        let mut frames = Vec::new();
        while self.near.len() >= BLOCK {
            let block: Vec<f32> = self.near.drain(..BLOCK).collect();
            let clean = self.aec_block(&block);
            let out = if self.rnnoise {
                let input: Vec<f32> = clean.iter().map(|s| s * PCM_SCALE).collect();
                let mut denoised = [0.0_f32; BLOCK];
                self.denoise.process_frame(&mut denoised, &input);
                self.blocks += 1;
                if self.blocks == 1 {
                    continue;
                }
                denoised.iter().map(|s| s / PCM_SCALE).collect::<Vec<f32>>()
            } else {
                self.blocks += 1;
                clean.to_vec()
            };
            frames.extend(self.conv.push(&out));
        }
        frames
    }

    /// AEC3's own ERLE estimate in dB, once it has one.
    pub fn erle_db(&self) -> Option<f64> {
        self.apm.statistics().echo_return_loss_enhancement
    }

    /// How many far-end blocks carried audio. Zero after a few seconds means the loopback is not delivering.
    pub fn far_blocks_active(&self) -> u64 {
        self.far_blocks_active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic noise in -1..1 (LCG), so the numbers in the ADR are reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        }
    }

    /// Speech-like far-end: low-passed noise with a ~4 Hz syllable envelope.
    fn far_signal(seconds: usize, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed);
        let n = seconds * RATE as usize;
        let mut lp = 0.0_f32;
        (0..n)
            .map(|i| {
                lp += 0.35 * (rng.next() - lp);
                let t = i as f32 / RATE as f32;
                let env = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
                lp * env * 0.9
            })
            .collect()
    }

    /// Room: direct path after `delay` samples, plus two weaker reflections.
    fn echo_of(far: &[f32], delay: usize) -> Vec<f32> {
        let taps = [(delay, 0.5_f32), (delay + 190, 0.2), (delay + 611, -0.1)];
        let mut out = vec![0.0_f32; far.len()];
        for (i, o) in out.iter_mut().enumerate() {
            for (d, g) in taps {
                if i >= d {
                    *o += far[i - d] * g;
                }
            }
        }
        out
    }

    fn power(x: &[f32]) -> f64 {
        x.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>() / x.len().max(1) as f64
    }

    fn db(ratio: f64) -> f64 {
        10.0 * ratio.max(1e-20).log10()
    }

    /// Runs `near` through AEC3 with `far` as reference, block by block; returns the AEC output.
    fn run_aec(far: &[f32], near: &[f32]) -> Vec<f32> {
        let mut p = MicPipeline::new(false);
        let mut out = Vec::with_capacity(near.len());
        for i in 0..near.len().min(far.len()) / BLOCK {
            let r = i * BLOCK..(i + 1) * BLOCK;
            p.push_far(&far[r.clone()]);
            out.extend_from_slice(&p.aec_block(&near[r]));
        }
        out
    }

    #[test]
    fn echo_is_cancelled_by_more_than_15_db() {
        let secs = 12;
        let far = far_signal(secs, 7);
        let near = echo_of(&far, 1_920); // 40 ms
        let out = run_aec(&far, &near);
        let tail = (secs - 3) * RATE as usize..;
        let erle = db(power(&near[tail.clone()]) / power(&out[tail]));
        println!("ERLE after convergence (last 3 s): {erle:.1} dB");
        assert!(erle > 15.0, "ERLE {erle:.1} dB");
    }

    #[test]
    fn echo_is_cancelled_with_a_long_delay() {
        // Loopback capture and mic are not on the same clock: 120 ms between reference and echo.
        let secs = 12;
        let far = far_signal(secs, 11);
        let near = echo_of(&far, 5_760);
        let out = run_aec(&far, &near);
        let tail = (secs - 3) * RATE as usize..;
        let erle = db(power(&near[tail.clone()]) / power(&out[tail]));
        println!("ERLE, 120 ms delay (last 3 s): {erle:.1} dB");
        assert!(erle > 15.0, "ERLE {erle:.1} dB");
    }

    #[test]
    fn the_near_talker_survives_while_the_far_end_plays() {
        let secs = 12;
        let far = far_signal(secs, 21);
        let echo = echo_of(&far, 1_920);
        // Near talker: a voiced-like tone burst train, never overlapping the first 4 s (convergence).
        let talker: Vec<f32> = (0..far.len())
            .map(|i| {
                let t = i as f32 / RATE as f32;
                if t < 4.0 {
                    return 0.0;
                }
                let gate = if (t * 2.0).fract() < 0.5 { 1.0 } else { 0.0 };
                gate * 0.25
                    * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
            })
            .collect();
        let near: Vec<f32> = echo.iter().zip(&talker).map(|(e, t)| e + t).collect();
        let out = run_aec(&far, &near);
        let from = 6 * RATE as usize;
        let kept = db(power(&out[from..]) / power(&talker[from..]));
        println!("near talker level through AEC during far-end playback: {kept:.1} dB");
        assert!(kept > -6.0, "talker attenuated by {kept:.1} dB");
    }

    #[test]
    fn silent_loopback_leaves_the_mic_alone() {
        // No far-end at all (nothing playing): AEC must not eat the voice.
        let near: Vec<f32> = (0..RATE as usize * 3)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 300.0 * i as f32 / RATE as f32).sin())
            .collect();
        let far = vec![0.0_f32; near.len()];
        let out = run_aec(&far, &near);
        let from = RATE as usize;
        let kept = db(power(&out[from..]) / power(&near[from..]));
        println!("mic level with a silent loopback: {kept:.1} dB");
        assert!(kept > -3.0, "voice attenuated by {kept:.1} dB");
    }

    #[test]
    fn output_is_16k_mono_s16_in_20ms_frames() {
        let mut p = MicPipeline::new(true);
        let near = far_signal(1, 3);
        // Feed in odd chunks: framing must not depend on the chunk size.
        let mut frames = Vec::new();
        for chunk in near.chunks(997) {
            frames.extend(p.push_near(chunk));
        }
        assert!(frames.iter().all(|f| f.len() == 640));
        // 1 s = 50 frames, minus the dropped RNNoise fade-in block and the partial tail.
        assert!((47..=50).contains(&frames.len()), "{} frames", frames.len());
    }

    #[test]
    fn rnnoise_reduces_steady_noise() {
        // Hiss with no voice: RNNoise should take it well down.
        let mut rng = Rng(99);
        let noise: Vec<f32> = (0..RATE as usize * 3).map(|_| rng.next() * 0.05).collect();
        let mut p = MicPipeline::new(true);
        let frames = p.push_near(&noise);
        let bytes: Vec<u8> = frames.iter().flatten().copied().collect();
        let pcm: Vec<f32> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| f32::from(i16::from_le_bytes(*b)) / 32_768.0)
            .collect();
        let from = pcm.len() / 3;
        let reduction = db(power(&noise) / power(&pcm[from..]));
        println!("RNNoise on steady hiss: {reduction:.1} dB reduction");
        assert!(reduction > 10.0, "{reduction:.1} dB");
    }

    #[test]
    fn far_queue_is_bounded() {
        let mut p = MicPipeline::new(false);
        p.push_far(&vec![0.1; RATE as usize * 5]);
        assert!(p.far.len() <= MAX_FAR_SAMPLES);
    }

    #[test]
    fn downmix_averages() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
    }
}
