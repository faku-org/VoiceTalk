// Release builds hide the console window; dev keeps it so sidecar logs show up.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voicetalk_lib::run()
}
