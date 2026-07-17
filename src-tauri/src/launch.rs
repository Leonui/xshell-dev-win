use portable_pty::CommandBuilder;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

const MAX_ARGUMENTS: usize = 4096;
const MAX_TOTAL_BYTES: usize = 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES: usize = 512;
const MAX_PREFLIGHT_PATHS: usize = 128;
const MAX_PREFLIGHT_SHELLS: usize = 32;
const MAX_PREFLIGHT_COMMANDS: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum StructuredCommand {
    Argv { program: String, args: Vec<String> },
    Shell { line: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalLaunchSpec {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) shell_id: Option<String>,
    #[serde(default)]
    pub(crate) command: Option<StructuredCommand>,
    #[serde(default)]
    pub(crate) env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) keep_open: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandLaunchPreflight {
    launch: TerminalLaunchSpec,
    cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessPlan {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate_env(env: Option<&HashMap<String, String>>) -> Result<Vec<(String, String)>, String> {
    let Some(env) = env else {
        return Ok(Vec::new());
    };
    if env.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err("Command environment has too many entries".to_string());
    }
    let mut entries = Vec::with_capacity(env.len());
    for (name, value) in env {
        if !valid_env_name(name) {
            return Err(format!("Invalid environment variable name: {name}"));
        }
        let normalized_name = name.to_ascii_uppercase();
        if matches!(
            normalized_name.as_str(),
            "TERM_PROGRAM" | "PATH" | "PATHEXT"
        ) || normalized_name.starts_with("XSHELL_")
        {
            return Err(format!("Environment variable {name} is reserved by xshell"));
        }
        if value.contains('\0') {
            return Err(format!("Environment variable {name} contains a NUL byte"));
        }
        entries.push((name.clone(), value.clone()));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn cmd_quote(value: &str) -> Result<String, String> {
    if value
        .bytes()
        .any(|byte| matches!(byte, b'\r' | b'\n' | b'\0' | b'%' | b'!' | b'"'))
    {
        return Err("cmd.exe keep-open argv cannot safely represent quotes, percent expansion, delayed expansion, or newlines; use PowerShell or disable keep-open".to_string());
    }
    Ok(format!("\"{value}\""))
}

fn shell_plan(
    host_shell: &str,
    shell_id: &str,
    line: String,
    keep_open: bool,
) -> Result<(String, Vec<String>), String> {
    match shell_id {
        "powershell" | "pwsh" => {
            let mut args = vec!["-NoLogo".to_string()];
            if keep_open {
                args.push("-NoExit".to_string());
            }
            args.extend(["-Command".to_string(), line]);
            Ok((host_shell.to_string(), args))
        }
        "cmd" => Ok((
            host_shell.to_string(),
            vec![
                "/D".to_string(),
                "/S".to_string(),
                if keep_open { "/K" } else { "/C" }.to_string(),
                line,
            ],
        )),
        "gitbash" | "bash" | "zsh" | "fish" => {
            let command = if keep_open {
                let executable = std::path::Path::new(host_shell)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("bash");
                format!("{line}; exec {} -i", posix_quote(executable))
            } else {
                line
            };
            Ok((
                host_shell.to_string(),
                vec!["-i".to_string(), "-c".to_string(), command],
            ))
        }
        _ => Err(format!(
            "Shell preset {shell_id} cannot run structured commands"
        )),
    }
}

fn resolved_argv_program(program: &str, shell_id: &str, keep_open: bool) -> String {
    #[cfg(windows)]
    if !keep_open {
        if let Some(resolved) = super::resolve_native_executable(program) {
            return resolved;
        }
        if let Some(resolved) = super::resolve_batch_script(program) {
            return resolved;
        }
    } else if matches!(shell_id, "powershell" | "pwsh" | "cmd") {
        if let Some(resolved) = super::resolve_batch_script(program) {
            return resolved;
        }
    }
    let _ = (shell_id, keep_open);
    program.to_string()
}

#[cfg(windows)]
fn is_windows_batch_program(program: &str) -> bool {
    Path::new(program)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

#[cfg(windows)]
fn is_windows_native_program(program: &str) -> bool {
    Path::new(program)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        })
}

pub(crate) fn plan_command_launch(
    launch: &TerminalLaunchSpec,
    host_shell: &str,
    shell_id: &str,
) -> Result<ProcessPlan, String> {
    if launch.kind != "command" {
        return Err("Launch specification is not a command".to_string());
    }
    if launch.shell_id.as_deref() != Some(shell_id) {
        return Err("Command shell does not match the selected shell preset".to_string());
    }
    let command = launch
        .command
        .as_ref()
        .ok_or_else(|| "Command launch is missing its command".to_string())?;
    let env = validate_env(launch.env.as_ref())?;
    let keep_open = launch.keep_open.unwrap_or(false);

    let (program, args) = match command {
        StructuredCommand::Argv { program, args } => {
            if program.trim().is_empty() || program.contains('\0') {
                return Err("Command program must be non-empty and NUL-free".to_string());
            }
            if args.len() > MAX_ARGUMENTS || args.iter().any(|argument| argument.contains('\0')) {
                return Err(
                    "Command arguments are invalid or exceed the argument limit".to_string()
                );
            }
            let resolved_program = resolved_argv_program(program, shell_id, keep_open);
            #[cfg(windows)]
            if !keep_open && is_windows_batch_program(&resolved_program) {
                return Err(
                    "Windows batch commands require keepOpen so the selected shell can invoke them"
                        .to_string(),
                );
            }
            #[cfg(windows)]
            if !keep_open && !is_windows_native_program(&resolved_program) {
                return Err(
                    "Direct Windows argv commands require a native EXE or COM executable; use keepOpen for CMD or BAT commands"
                        .to_string(),
                );
            }
            if keep_open {
                let line = match shell_id {
                    "powershell" | "pwsh" => format!(
                        "& {}",
                        std::iter::once(powershell_quote(&resolved_program))
                            .chain(args.iter().map(|argument| powershell_quote(argument)))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ),
                    "gitbash" | "bash" | "zsh" | "fish" => {
                        std::iter::once(posix_quote(&resolved_program))
                            .chain(args.iter().map(|argument| posix_quote(argument)))
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                    "cmd" => std::iter::once(cmd_quote(&resolved_program))
                        .chain(args.iter().map(|argument| cmd_quote(argument)))
                        .collect::<Result<Vec<_>, _>>()?
                        .join(" "),
                    _ => {
                        return Err(format!(
                            "Shell preset {shell_id} cannot keep an argv command open"
                        ))
                    }
                };
                shell_plan(host_shell, shell_id, line, true)?
            } else {
                (resolved_program, args.clone())
            }
        }
        StructuredCommand::Shell { line } => {
            if line.trim().is_empty() || line.contains('\0') {
                return Err("Shell command must be non-empty and NUL-free".to_string());
            }
            shell_plan(host_shell, shell_id, line.clone(), keep_open)?
        }
    };
    let total_bytes = program.len()
        + args.iter().map(String::len).sum::<usize>()
        + env
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>();
    if total_bytes > MAX_TOTAL_BYTES {
        return Err("Command launch exceeds the size limit".to_string());
    }
    Ok(ProcessPlan { program, args, env })
}

pub(crate) fn command_builder(plan: ProcessPlan) -> CommandBuilder {
    let mut command = CommandBuilder::new(plan.program);
    for argument in plan.args {
        command.arg(argument);
    }
    for (name, value) in plan.env {
        command.env(name, value);
    }
    command
}

fn missing_directories(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > MAX_PREFLIGHT_PATHS {
        return Err(format!(
            "Directory preflight is limited to {MAX_PREFLIGHT_PATHS} paths"
        ));
    }
    let mut missing = Vec::new();
    for path in paths {
        if path.trim().is_empty() || path.contains('\0') {
            return Err("Directory preflight paths must be non-empty and NUL-free".to_string());
        }
        if !Path::new(path).is_dir() && !missing.iter().any(|candidate| candidate == path) {
            missing.push(path.clone());
        }
    }
    Ok(missing)
}

#[tauri::command]
pub(crate) fn validate_directories(paths: Vec<String>) -> Result<Vec<String>, String> {
    missing_directories(&paths)
}

fn executable_file(path: &Path, allow_windows_batch: bool) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        extension.eq_ignore_ascii_case("exe")
            || extension.eq_ignore_ascii_case("com")
            || (allow_windows_batch
                && (extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(any(windows, unix)))]
    {
        true
    }
}

fn executable_exists(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command_path.components().count() > 1 {
        return executable_file(command_path, false);
    }
    let Some(path_value) = std::env::var_os("PATH") else {
        return false;
    };
    #[cfg(windows)]
    let extensions: Vec<String> = if command_path.extension().is_some() {
        vec![String::new()]
    } else {
        vec![".exe".to_string(), ".com".to_string()]
    };
    #[cfg(not(windows))]
    let extensions = vec![String::new()];

    std::env::split_paths(&path_value).any(|directory| {
        extensions.iter().any(|extension| {
            let candidate = if extension.is_empty() {
                directory.join(command)
            } else {
                directory.join(format!("{command}{extension}"))
            };
            executable_file(&candidate, false)
        })
    })
}

fn missing_shell_presets(shell_ids: &[String]) -> Result<Vec<String>, String> {
    if shell_ids.len() > MAX_PREFLIGHT_SHELLS {
        return Err(format!(
            "Shell preflight is limited to {MAX_PREFLIGHT_SHELLS} presets"
        ));
    }
    let mut missing = Vec::new();
    for shell_id in shell_ids {
        if shell_id.trim().is_empty() || shell_id.contains('\0') {
            return Err("Shell preset IDs must be non-empty and NUL-free".to_string());
        }
        let available = super::resolve_structured_shell(shell_id)
            .is_ok_and(|command| executable_exists(&command));
        if !available && !missing.iter().any(|candidate| candidate == shell_id) {
            missing.push(shell_id.clone());
        }
    }
    Ok(missing)
}

#[tauri::command]
pub(crate) fn validate_shell_presets(shell_ids: Vec<String>) -> Result<Vec<String>, String> {
    missing_shell_presets(&shell_ids)
}

fn argv_program_available(program: &str, cwd: &str, shell_id: &str, keep_open: bool) -> bool {
    let path = Path::new(program);
    if path.is_absolute() {
        return executable_file(path, keep_open);
    }
    if path.components().count() > 1 {
        let base = if cwd.is_empty() {
            dirs::home_dir().unwrap_or_else(|| Path::new(".").to_path_buf())
        } else {
            Path::new(cwd).to_path_buf()
        };
        let candidate = base.join(path);
        if executable_file(&candidate, keep_open) {
            return true;
        }
        #[cfg(windows)]
        if candidate.extension().is_none() {
            let extensions: &[&str] = if keep_open {
                &["exe", "com", "cmd", "bat"]
            } else {
                &["exe", "com"]
            };
            return extensions.iter().any(|extension| {
                let mut with_extension = candidate.clone();
                with_extension.set_extension(extension);
                executable_file(&with_extension, keep_open)
            });
        }
        return false;
    }
    let resolved = resolved_argv_program(program, shell_id, keep_open);
    let resolved_path = Path::new(&resolved);
    if resolved_path.is_absolute() || resolved_path.components().count() > 1 {
        executable_file(resolved_path, keep_open)
    } else {
        executable_exists(&resolved)
    }
}

fn validate_command_launches_impl(launches: &[CommandLaunchPreflight]) -> Result<(), String> {
    if launches.len() > MAX_PREFLIGHT_COMMANDS {
        return Err(format!(
            "Command preflight is limited to {MAX_PREFLIGHT_COMMANDS} launches"
        ));
    }
    for (index, preflight) in launches.iter().enumerate() {
        let launch = &preflight.launch;
        let shell_id = launch
            .shell_id
            .as_deref()
            .ok_or_else(|| format!("Command {} has no shell preset", index + 1))?;
        let host_shell = super::resolve_structured_shell(shell_id)
            .map_err(|error| format!("Command {}: {error}", index + 1))?;
        if !executable_exists(&host_shell) {
            return Err(format!(
                "Command {} shell executable is unavailable: {host_shell}",
                index + 1
            ));
        }
        plan_command_launch(launch, &host_shell, shell_id)
            .map_err(|error| format!("Command {}: {error}", index + 1))?;
        if let Some(StructuredCommand::Argv { program, .. }) = launch.command.as_ref() {
            if !argv_program_available(
                program,
                &preflight.cwd,
                shell_id,
                launch.keep_open.unwrap_or(false),
            ) {
                return Err(format!(
                    "Command {} executable is unavailable: {program}",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn validate_command_launches(
    launches: Vec<CommandLaunchPreflight>,
) -> Result<(), String> {
    validate_command_launches_impl(&launches)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(shell_id: &str, keep_open: bool) -> TerminalLaunchSpec {
        TerminalLaunchSpec {
            kind: "command".to_string(),
            shell_id: Some(shell_id.to_string()),
            command: Some(StructuredCommand::Argv {
                program: "tool name".to_string(),
                args: vec![
                    "plain".to_string(),
                    "a'b".to_string(),
                    "$(unsafe)".to_string(),
                ],
            }),
            env: Some(HashMap::from([("PORT".to_string(), "4100".to_string())])),
            keep_open: Some(keep_open),
        }
    }

    #[test]
    fn argv_without_keep_open_never_uses_a_shell() {
        let plan = plan_command_launch(&argv("powershell", false), "powershell.exe", "powershell")
            .unwrap();
        assert_eq!(plan.program, "tool name");
        assert_eq!(plan.args, ["plain", "a'b", "$(unsafe)"]);
        assert_eq!(plan.env, [("PORT".to_string(), "4100".to_string())]);
    }

    #[test]
    fn keep_open_quotes_every_powershell_argument() {
        let plan =
            plan_command_launch(&argv("powershell", true), "powershell.exe", "powershell").unwrap();
        assert_eq!(plan.program, "powershell.exe");
        assert_eq!(
            plan.args,
            [
                "-NoLogo",
                "-NoExit",
                "-Command",
                "& 'tool name' 'plain' 'a''b' '$(unsafe)'"
            ]
        );
    }

    #[test]
    fn rejects_reserved_xshell_environment_variables() {
        let mut launch = argv("powershell", false);
        launch.env = Some(HashMap::from([(
            "XSHELL_ACTIVITY_DIR".to_string(),
            "attacker".to_string(),
        )]));
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("reserved"));
        launch.env = Some(HashMap::from([(
            "xShell_activity_dir".to_string(),
            "attacker".to_string(),
        )]));
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("reserved"));
        launch.env = Some(HashMap::from([(
            "term_program".to_string(),
            "attacker".to_string(),
        )]));
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("reserved"));
        launch.env = Some(HashMap::from([(
            "Path".to_string(),
            "attacker".to_string(),
        )]));
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("reserved"));
    }

    #[test]
    fn explicit_shell_lines_use_only_the_selected_preset() {
        let launch = TerminalLaunchSpec {
            kind: "command".to_string(),
            shell_id: Some("bash".to_string()),
            command: Some(StructuredCommand::Shell {
                line: "npm run dev && echo ready".to_string(),
            }),
            env: None,
            keep_open: Some(false),
        };
        let plan = plan_command_launch(&launch, "/bin/bash", "bash").unwrap();
        assert_eq!(
            plan,
            ProcessPlan {
                program: "/bin/bash".to_string(),
                args: vec![
                    "-i".to_string(),
                    "-c".to_string(),
                    "npm run dev && echo ready".to_string()
                ],
                env: Vec::new(),
            }
        );
    }

    #[test]
    fn cmd_keep_open_rejects_expansion_sequences() {
        let mut launch = argv("cmd", true);
        launch.command = Some(StructuredCommand::Argv {
            program: "echo".to_string(),
            args: vec!["%PATH%".to_string()],
        });
        assert!(plan_command_launch(&launch, "cmd.exe", "cmd").is_err());
    }

    #[test]
    fn directory_preflight_reports_only_missing_paths() {
        let existing = std::env::temp_dir().to_string_lossy().into_owned();
        let missing = std::env::temp_dir()
            .join("xshell-definitely-missing-preflight-dir")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            missing_directories(&[existing, missing.clone(), missing.clone()]).unwrap(),
            [missing]
        );
        assert!(missing_directories(&[String::new()]).is_err());
    }

    #[test]
    fn shell_preflight_rejects_unknown_presets_without_duplicates() {
        let missing =
            missing_shell_presets(&["not-a-shell".to_string(), "not-a-shell".to_string()]).unwrap();
        assert_eq!(missing, ["not-a-shell"]);
    }

    #[test]
    fn command_preflight_rejects_a_missing_bare_executable() {
        let mut launch = argv(if cfg!(windows) { "powershell" } else { "bash" }, false);
        launch.command = Some(StructuredCommand::Argv {
            program: "xshell-command-that-does-not-exist-7ec3a8".to_string(),
            args: Vec::new(),
        });
        assert!(validate_command_launches_impl(&[CommandLaunchPreflight {
            launch,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        }])
        .unwrap_err()
        .contains("executable is unavailable"));
    }

    #[test]
    fn command_preflight_rejects_a_missing_relative_executable() {
        let mut launch = argv(if cfg!(windows) { "powershell" } else { "bash" }, false);
        launch.command = Some(StructuredCommand::Argv {
            program: "./xshell-command-that-does-not-exist-1d857e".to_string(),
            args: Vec::new(),
        });
        assert!(validate_command_launches_impl(&[CommandLaunchPreflight {
            launch,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        }])
        .unwrap_err()
        .contains("executable is unavailable"));
    }

    #[cfg(windows)]
    #[test]
    fn direct_argv_rejects_windows_batch_programs() {
        let mut launch = argv("powershell", false);
        launch.command = Some(StructuredCommand::Argv {
            program: "tool.cmd".to_string(),
            args: Vec::new(),
        });
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("require keepOpen"));
    }

    #[cfg(windows)]
    #[test]
    fn direct_argv_rejects_non_native_windows_scripts() {
        let mut launch = argv("powershell", false);
        launch.command = Some(StructuredCommand::Argv {
            program: "tool.ps1".to_string(),
            args: Vec::new(),
        });
        assert!(plan_command_launch(&launch, "powershell.exe", "powershell")
            .unwrap_err()
            .contains("native EXE or COM"));
    }

    #[cfg(unix)]
    #[test]
    fn executable_check_rejects_a_non_executable_unix_file() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!(
            "xshell-non-executable-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable_file(&path, false));
        let _ = std::fs::remove_file(path);
    }

    #[cfg(windows)]
    #[test]
    fn direct_argv_resolution_detects_a_bat_only_program() {
        let root = std::env::temp_dir().join(format!("xshell-bat-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let batch = root.join("xshell-bat-only.bat");
        std::fs::write(&batch, "@exit /b 0\r\n").unwrap();
        let path = std::env::join_paths([root.as_path()]).unwrap();
        let resolved = super::super::find_batch_script_in_path("xshell-bat-only", &path).unwrap();
        assert!(is_windows_batch_program(&resolved));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn powershell_argv_prefers_a_cmd_shim() {
        let root = std::env::temp_dir().join(format!("xshell-shim-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let shim = root.join("xshell-test-tool.cmd");
        std::fs::write(&shim, "@exit /b 0\r\n").unwrap();
        let path = std::env::join_paths([root.as_path()]).unwrap();
        assert_eq!(
            super::super::find_cmd_shim_in_path("xshell-test-tool", &path),
            Some(shim.to_string_lossy().into_owned())
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
