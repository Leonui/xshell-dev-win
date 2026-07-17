use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const HOOK_MARKER: &str = "XSHELL_ACTIVITY_HOOK_V1";
const MAX_HOOK_PAYLOAD_BYTES: u64 = 1024 * 1024;
const EVENT_VERSION: u8 = 1;

#[derive(Debug)]
pub(crate) struct ActivityRunRegistration {
    pub(crate) directory: PathBuf,
    pub(crate) generation: u32,
    pub(crate) run_id: String,
    pub(crate) provider: String,
    next_seq: u64,
    seen_event_ids: HashSet<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolledActivityEvent {
    pub(crate) tab_id: String,
    pub(crate) event_id: String,
    pub(crate) generation: u32,
    pub(crate) run_id: String,
    pub(crate) seq: u64,
    pub(crate) at: u64,
    pub(crate) source: &'static str,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHookStatus {
    pub(crate) provider: &'static str,
    pub(crate) path: String,
    pub(crate) installed: bool,
    pub(crate) manual_trust_required: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityHooksProbe {
    pub(crate) claude: ProviderHookStatus,
    pub(crate) codex: ProviderHookStatus,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookRecord {
    version: u8,
    provider: String,
    tab_id: String,
    event_id: String,
    generation: u32,
    run_id: String,
    at: u64,
    kind: String,
}

#[derive(Debug)]
struct HookEnvironment {
    directory: PathBuf,
    tab_id: String,
    generation: u32,
    run_id: String,
    provider: String,
}

fn activity_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::cache_dir)
        .ok_or_else(|| "No per-user application data directory is available".to_string())?;
    Ok(base.join("xshell").join("activity-v1"))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "claude" | "codex" => Ok(provider),
        _ => Err("Activity hooks support only Claude and Codex".to_string()),
    }
}

pub(crate) fn register_run(
    registrations: &mut HashMap<String, ActivityRunRegistration>,
    tab_id: &str,
    generation: u32,
    run_id: &str,
    provider: &str,
) -> Result<PathBuf, String> {
    validate_provider(provider)?;
    if !valid_identifier(tab_id) {
        return Err("Invalid terminal activity identifier".to_string());
    }
    Uuid::parse_str(run_id).map_err(|_| "Invalid terminal activity run ID".to_string())?;

    if let Some(previous) = registrations.remove(tab_id) {
        let _ = fs::remove_dir_all(previous.directory);
    }

    let root = activity_root()?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create activity directory: {error}"))?;
    let directory = root.join(Uuid::new_v4().to_string());
    fs::create_dir(&directory)
        .map_err(|error| format!("Failed to create terminal activity directory: {error}"))?;

    registrations.insert(
        tab_id.to_string(),
        ActivityRunRegistration {
            directory: directory.clone(),
            generation,
            run_id: run_id.to_string(),
            provider: provider.to_string(),
            // PTY spawn-started/spawn-ready use 0 and 1. Hook events occupy the range above
            // them; later PTY exit events are allocated from the reducer's current sequence.
            next_seq: 99,
            seen_event_ids: HashSet::new(),
        },
    );
    Ok(directory)
}

pub(crate) fn register_run_best_effort(
    registrations: &mut HashMap<String, ActivityRunRegistration>,
    tab_id: &str,
    generation: u32,
    run_id: &str,
    provider: &str,
) -> Option<PathBuf> {
    register_run(registrations, tab_id, generation, run_id, provider).ok()
}

pub(crate) fn unregister_run(
    registrations: &mut HashMap<String, ActivityRunRegistration>,
    tab_id: &str,
) {
    if let Some(registration) = registrations.remove(tab_id) {
        let _ = fs::remove_dir_all(registration.directory);
    }
}

pub(crate) fn poll_events(
    registrations: &mut HashMap<String, ActivityRunRegistration>,
) -> Vec<PolledActivityEvent> {
    let mut events = Vec::new();
    for (tab_id, registration) in registrations.iter_mut() {
        let Ok(entries) = fs::read_dir(&registration.directory) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        paths.sort();

        for path in paths {
            let record = fs::read(&path)
                .ok()
                .filter(|bytes| bytes.len() <= MAX_HOOK_PAYLOAD_BYTES as usize)
                .and_then(|bytes| serde_json::from_slice::<HookRecord>(&bytes).ok());
            let _ = fs::remove_file(&path);
            let Some(record) = record else { continue };
            if record.version != EVENT_VERSION
                || record.tab_id != *tab_id
                || record.generation != registration.generation
                || record.run_id != registration.run_id
                || record.provider != registration.provider
                || !is_activity_kind(&record.kind)
                || !registration.seen_event_ids.insert(record.event_id.clone())
            {
                continue;
            }

            registration.next_seq = registration.next_seq.saturating_add(1);
            events.push(PolledActivityEvent {
                tab_id: tab_id.clone(),
                event_id: record.event_id,
                generation: record.generation,
                run_id: record.run_id,
                seq: registration.next_seq,
                at: record.at,
                source: "hook",
                kind: record.kind,
            });
        }
    }
    events.sort_by(|left, right| {
        left.at
            .cmp(&right.at)
            .then_with(|| left.tab_id.cmp(&right.tab_id))
            .then_with(|| left.seq.cmp(&right.seq))
    });
    events
}

fn is_activity_kind(kind: &str) -> bool {
    matches!(
        kind,
        "prompt-submitted"
            | "work-resumed"
            | "turn-completed"
            | "needs-permission"
            | "needs-input"
            | "agent-failed"
    )
}

fn hook_environment(provider_arg: &str) -> Result<HookEnvironment, String> {
    validate_provider(provider_arg)?;
    let provider = std::env::var("XSHELL_ACTIVITY_PROVIDER")
        .map_err(|_| "Missing activity provider".to_string())?;
    if provider != provider_arg {
        return Err("Activity provider does not match the terminal registration".to_string());
    }
    let tab_id = std::env::var("XSHELL_ACTIVITY_TAB_ID")
        .map_err(|_| "Missing terminal activity identifier".to_string())?;
    if !valid_identifier(&tab_id) {
        return Err("Invalid terminal activity identifier".to_string());
    }
    let generation = std::env::var("XSHELL_ACTIVITY_GENERATION")
        .map_err(|_| "Missing terminal activity generation".to_string())?
        .parse::<u32>()
        .map_err(|_| "Invalid terminal activity generation".to_string())?;
    let run_id = std::env::var("XSHELL_ACTIVITY_RUN_ID")
        .map_err(|_| "Missing terminal activity run ID".to_string())?;
    Uuid::parse_str(&run_id).map_err(|_| "Invalid terminal activity run ID".to_string())?;
    let directory = PathBuf::from(
        std::env::var_os("XSHELL_ACTIVITY_DIR")
            .ok_or_else(|| "Missing terminal activity directory".to_string())?,
    );
    let root = activity_root()?;
    let directory_id = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid terminal activity directory".to_string())?;
    if directory.parent() != Some(root.as_path()) || Uuid::parse_str(directory_id).is_err() {
        return Err("Terminal activity directory is outside xshell storage".to_string());
    }
    Ok(HookEnvironment {
        directory,
        tab_id,
        generation,
        run_id,
        provider,
    })
}

fn hook_kind(provider: &str, payload: &Value) -> Result<Option<&'static str>, String> {
    let event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .or_else(|| payload.get("hookEventName").and_then(Value::as_str));
    if provider == "codex"
        && payload.get("type").and_then(Value::as_str) == Some("agent-turn-complete")
    {
        return Ok(Some("turn-completed"));
    }
    match (provider, event_name) {
        ("claude" | "codex", Some("UserPromptSubmit")) => Ok(Some("prompt-submitted")),
        ("claude" | "codex", Some("Stop")) => Ok(Some("turn-completed")),
        ("claude" | "codex", Some("PermissionRequest")) => Ok(Some("needs-permission")),
        ("claude", Some("StopFailure")) => Ok(Some("agent-failed")),
        ("claude", Some("Notification")) => {
            match payload.get("notification_type").and_then(Value::as_str) {
                Some("permission_prompt") => Ok(Some("needs-permission")),
                Some("idle_prompt") => Ok(Some("needs-input")),
                _ => Ok(None),
            }
        }
        (_, Some(_)) => Err("Unsupported provider lifecycle event".to_string()),
        _ => Err("Missing provider lifecycle event name".to_string()),
    }
}

fn write_hook_record(
    environment: &HookEnvironment,
    payload: &Value,
) -> Result<Option<PathBuf>, String> {
    let Some(kind) = hook_kind(&environment.provider, payload)? else {
        return Ok(None);
    };
    if !environment.directory.is_dir() {
        return Err("Terminal activity registration is no longer active".to_string());
    }
    let event_id = Uuid::new_v4().to_string();
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let record = HookRecord {
        version: EVENT_VERSION,
        provider: environment.provider.clone(),
        tab_id: environment.tab_id.clone(),
        event_id: event_id.clone(),
        generation: environment.generation,
        run_id: environment.run_id.clone(),
        at,
        kind: kind.to_string(),
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Failed to encode terminal activity event: {error}"))?;
    let base_name = format!("{at:013}-{event_id}");
    let temporary = environment.directory.join(format!(".{base_name}.tmp"));
    let destination = environment.directory.join(format!("{base_name}.json"));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Failed to write terminal activity event: {error}"))?;
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Failed to publish terminal activity event: {error}"))?;
    Ok(Some(destination))
}

fn parse_hook_payload(bytes: &[u8], extra_argument: Option<&OsString>) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_HOOK_PAYLOAD_BYTES {
        return Err("Hook payload is too large".to_string());
    }
    if bytes.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return serde_json::from_slice(bytes)
            .map_err(|_| "Hook payload is not valid JSON".to_string());
    }
    let argument = extra_argument
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Hook payload is empty".to_string())?;
    serde_json::from_str(argument).map_err(|_| "Hook payload is not valid JSON".to_string())
}

fn read_hook_payload(extra_argument: Option<&OsString>) -> Result<Value, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_HOOK_PAYLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read hook payload: {error}"))?;
    parse_hook_payload(&bytes, extra_argument)
}

/// Handles the short-lived lifecycle hook invocation before Tauri initializes.
pub fn try_run_activity_hook_cli(args: &[OsString]) -> Option<i32> {
    if args.get(1).and_then(|arg| arg.to_str()) != Some("--activity-hook") {
        return None;
    }
    let result = (|| {
        let provider = args
            .get(2)
            .and_then(|arg| arg.to_str())
            .ok_or_else(|| "Missing activity hook provider".to_string())?;
        if args.get(3).and_then(|arg| arg.to_str()) != Some(HOOK_MARKER) {
            return Err("Invalid activity hook marker".to_string());
        }
        let payload = read_hook_payload(args.get(4))?;
        let environment = hook_environment(provider)?;
        write_hook_record(&environment, &payload)?;
        Ok(())
    })();
    // This hook is an observer installed in provider-global configuration. Missing xshell
    // registration data and write failures must never reject prompts or deny permissions.
    let _ = result;
    Some(0)
}

fn provider_config_path(provider: &str, home: &Path) -> Result<PathBuf, String> {
    match provider {
        "claude" => Ok(home.join(".claude").join("settings.json")),
        "codex" => Ok(home.join(".codex").join("hooks.json")),
        _ => Err("Activity hooks support only Claude and Codex".to_string()),
    }
}

fn hook_command(executable: &Path, provider: &str) -> Result<String, String> {
    validate_provider(provider)?;
    let executable = executable
        .to_str()
        .ok_or_else(|| "The xshell executable path is not valid Unicode".to_string())?;
    #[cfg(windows)]
    let quoted = format!("\"{}\"", executable.replace('"', "\"\""));
    #[cfg(not(windows))]
    let quoted = format!("'{}'", executable.replace('\'', "'\\''"));
    Ok(format!("{quoted} --activity-hook {provider} {HOOK_MARKER}"))
}

fn hook_specs(provider: &str) -> Result<Vec<(&'static str, Option<&'static str>)>, String> {
    match provider {
        "claude" => Ok(vec![
            ("UserPromptSubmit", None),
            ("Stop", None),
            ("PermissionRequest", None),
            ("Notification", Some("permission_prompt|idle_prompt")),
            ("StopFailure", None),
        ]),
        "codex" => Ok(vec![
            ("UserPromptSubmit", None),
            ("Stop", None),
            ("PermissionRequest", None),
        ]),
        _ => Err("Activity hooks support only Claude and Codex".to_string()),
    }
}

fn is_owned_hook(entry: &Value, provider: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| {
                        command.contains(HOOK_MARKER)
                            && command.contains(&format!("--activity-hook {provider}"))
                    })
            })
        })
}

fn merge_hook_config(mut root: Value, provider: &str, command: &str) -> Result<Value, String> {
    validate_provider(provider)?;
    if root.is_null() {
        root = json!({});
    }
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "Provider configuration must be a JSON object".to_string())?;
    let hooks = root_object
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Provider hooks configuration must be a JSON object".to_string())?;

    for (event, matcher) in hook_specs(provider)? {
        let entries = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("Provider hook '{event}' must be an array"))?;
        entries.retain(|entry| !is_owned_hook(entry, provider));
        let mut hook_entry = Map::new();
        if let Some(matcher) = matcher {
            hook_entry.insert("matcher".to_string(), Value::String(matcher.to_string()));
        }
        hook_entry.insert(
            "hooks".to_string(),
            json!([{ "type": "command", "command": command }]),
        );
        entries.push(Value::Object(hook_entry));
    }
    Ok(root)
}

fn provider_is_installed(root: &Value, provider: &str) -> bool {
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    hook_specs(provider).is_ok_and(|specs| {
        specs.iter().all(|(event, _)| {
            hooks
                .get(*event)
                .and_then(Value::as_array)
                .is_some_and(|entries| entries.iter().any(|entry| is_owned_hook(entry, provider)))
        })
    })
}

fn read_json_config(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

fn write_json_config(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Provider configuration path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to encode provider configuration: {error}"))?;
    let temporary = parent.join(format!(".xshell-hooks-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
    if path.exists() {
        let backup = parent.join(format!(".xshell-hooks-{}.bak", Uuid::new_v4()));
        fs::rename(path, &backup)
            .map_err(|error| format!("Failed to stage {}: {error}", path.display()))?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(&backup, path);
            let _ = fs::remove_file(&temporary);
            return Err(format!("Failed to replace {}: {error}", path.display()));
        }
        let _ = fs::remove_file(backup);
    } else {
        fs::rename(&temporary, path)
            .map_err(|error| format!("Failed to publish {}: {error}", path.display()))?;
    }
    Ok(())
}

fn probe_provider(provider: &'static str, home: &Path) -> ProviderHookStatus {
    let path = provider_config_path(provider, home).expect("known provider");
    match read_json_config(&path) {
        Ok(root) => {
            let installed = provider_is_installed(&root, provider);
            ProviderHookStatus {
                provider,
                path: path.to_string_lossy().into_owned(),
                installed,
                // Codex requires users to approve unmanaged hooks. Configuration inspection
                // cannot establish that trust, so the UI must not report this as connected.
                manual_trust_required: provider == "codex" && installed,
                error: None,
            }
        }
        Err(error) => ProviderHookStatus {
            provider,
            path: path.to_string_lossy().into_owned(),
            installed: false,
            manual_trust_required: false,
            error: Some(error),
        },
    }
}

pub(crate) fn probe_hooks() -> Result<ActivityHooksProbe, String> {
    let home = dirs::home_dir().ok_or_else(|| "No home directory is available".to_string())?;
    Ok(ActivityHooksProbe {
        claude: probe_provider("claude", &home),
        codex: probe_provider("codex", &home),
    })
}

pub(crate) fn install_hooks(provider: &str) -> Result<ProviderHookStatus, String> {
    validate_provider(provider)?;
    let home = dirs::home_dir().ok_or_else(|| "No home directory is available".to_string())?;
    let path = provider_config_path(provider, &home)?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("Failed to locate xshell executable: {error}"))?;
    let command = hook_command(&executable, provider)?;
    let root = read_json_config(&path)?;
    let merged = merge_hook_config(root, provider, &command)?;
    write_json_config(&path, &merged)?;
    let provider = if provider == "claude" {
        "claude"
    } else {
        "codex"
    };
    Ok(probe_provider(provider, &home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_authoritative_provider_events() {
        assert_eq!(
            hook_kind(
                "claude",
                &json!({ "hook_event_name": "UserPromptSubmit", "prompt": "secret" })
            )
            .unwrap(),
            Some("prompt-submitted")
        );
        assert_eq!(
            hook_kind(
                "codex",
                &json!({ "hook_event_name": "Stop", "last_assistant_message": "secret" })
            )
            .unwrap(),
            Some("turn-completed")
        );
        assert_eq!(
            hook_kind("claude", &json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "secret" })).unwrap(),
            Some("needs-input")
        );
        assert!(hook_kind("codex", &json!({ "hook_event_name": "Notification" })).is_err());
        assert!(hook_kind("claude", &json!({ "hook_event_name": "PreToolUse" })).is_err());
    }

    #[test]
    fn stored_record_omits_sensitive_payload_fields() {
        let record = HookRecord {
            version: EVENT_VERSION,
            provider: "claude".to_string(),
            tab_id: "tab-1".to_string(),
            event_id: Uuid::new_v4().to_string(),
            generation: 3,
            run_id: Uuid::new_v4().to_string(),
            at: 10,
            kind: hook_kind(
                "claude",
                &json!({ "hook_event_name": "UserPromptSubmit", "prompt": "private prompt" }),
            )
            .unwrap()
            .unwrap()
            .to_string(),
        };
        let encoded = serde_json::to_string(&record).unwrap();
        assert!(!encoded.contains("private prompt"));
        assert!(!encoded.contains("prompt\""));
    }

    #[test]
    fn config_merge_is_idempotent_and_preserves_unrelated_settings() {
        let original = json!({
            "theme": "dark",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "other-tool" }] }],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "audit" }] }]
            }
        });
        let command = "'xshell' --activity-hook claude XSHELL_ACTIVITY_HOOK_V1";
        let once = merge_hook_config(original, "claude", command).unwrap();
        let twice = merge_hook_config(once.clone(), "claude", command).unwrap();
        assert_eq!(once, twice);
        assert_eq!(twice["theme"], "dark");
        assert_eq!(twice["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        assert_eq!(twice["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(provider_is_installed(&twice, "claude"));
    }

    #[test]
    fn codex_merge_does_not_add_unsupported_claude_events() {
        let merged = merge_hook_config(
            json!({ "unrelated": true }),
            "codex",
            "'xshell' --activity-hook codex XSHELL_ACTIVITY_HOOK_V1",
        )
        .unwrap();
        assert!(merged["hooks"].get("Notification").is_none());
        assert!(merged["hooks"].get("StopFailure").is_none());
        assert!(provider_is_installed(&merged, "codex"));
    }

    #[test]
    fn observer_cli_failures_are_always_non_blocking() {
        let args = [
            OsString::from("xshell"),
            OsString::from("--activity-hook"),
            OsString::from("claude"),
            OsString::from("invalid-marker"),
        ];
        assert_eq!(try_run_activity_hook_cli(&args), Some(0));
    }

    #[test]
    fn activity_registration_failure_degrades_without_a_registration() {
        let mut registrations = HashMap::new();
        let directory = register_run_best_effort(
            &mut registrations,
            "invalid legacy tab id",
            1,
            &Uuid::new_v4().to_string(),
            "claude",
        );
        assert!(directory.is_none());
        assert!(registrations.is_empty());
    }

    #[test]
    fn hook_payload_parser_rejects_malformed_and_oversized_input() {
        assert!(parse_hook_payload(b"not-json", None)
            .unwrap_err()
            .contains("valid JSON"));
        assert!(
            parse_hook_payload(&vec![b' '; MAX_HOOK_PAYLOAD_BYTES as usize + 1], None)
                .unwrap_err()
                .contains("too large")
        );
        let argument = OsString::from(r#"{"hook_event_name":"Stop"}"#);
        assert_eq!(
            parse_hook_payload(b"  \n", Some(&argument)).unwrap()["hook_event_name"],
            "Stop"
        );
    }

    #[test]
    fn polling_validates_registration_and_deduplicates_events() {
        let root = std::env::temp_dir().join(format!("xshell-activity-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let tab_id = "tab-1".to_string();
        let run_id = Uuid::new_v4().to_string();
        let event_id = Uuid::new_v4().to_string();
        let record = HookRecord {
            version: EVENT_VERSION,
            provider: "claude".to_string(),
            tab_id: tab_id.clone(),
            event_id: event_id.clone(),
            generation: 4,
            run_id: run_id.clone(),
            at: 20,
            kind: "turn-completed".to_string(),
        };
        fs::write(root.join("001.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        fs::write(root.join("002.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        fs::write(
            root.join("003.json"),
            serde_json::to_vec(&HookRecord {
                tab_id: "wrong".to_string(),
                ..record
            })
            .unwrap(),
        )
        .unwrap();
        let mut registrations = HashMap::from([(
            tab_id.clone(),
            ActivityRunRegistration {
                directory: root.clone(),
                generation: 4,
                run_id: run_id.clone(),
                provider: "claude".to_string(),
                next_seq: 99,
                seen_event_ids: HashSet::new(),
            },
        )]);
        let events = poll_events(&mut registrations);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, event_id);
        assert_eq!(events[0].seq, 100);
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }
}
