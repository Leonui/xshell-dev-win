#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(code) = xshell_lib::try_run_activity_hook_cli(&args) {
        std::process::exit(code);
    }
    xshell_lib::run()
}
