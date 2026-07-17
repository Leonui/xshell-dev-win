use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_LOCATION: u32 = 1_000_000;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EditorPreset {
    System,
    VisualStudioCode,
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // All variants are exercised by cross-platform command-spec tests.
enum Platform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandSpec {
    program: PathBuf,
    args: Vec<String>,
}

fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
}

fn validate_location(value: Option<u32>, label: &str) -> Result<Option<u32>, String> {
    match value {
        Some(0) => Err(format!("{label} must be at least 1")),
        Some(v) if v > MAX_LOCATION => Err(format!("{label} is too large")),
        value => Ok(value),
    }
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn resolve_file(path: &str, project_root: Option<&str>) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("file path is empty".into());
    }
    let expanded = expand_home(path.trim());
    let candidate = if expanded.is_absolute() {
        expanded
    } else {
        let root = project_root
            .filter(|root| !root.trim().is_empty())
            .ok_or_else(|| "relative file reference has no project root".to_string())?;
        Path::new(root).join(expanded)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("file does not exist: {} ({e})", candidate.display()))?;
    if !canonical.is_file() {
        return Err(format!("path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
}

fn location_arg(path: &Path, line: Option<u32>, column: Option<u32>) -> String {
    let base = path.to_string_lossy();
    match (line, column) {
        (Some(line), Some(column)) => format!("{base}:{line}:{column}"),
        (Some(line), None) => format!("{base}:{line}"),
        _ => base.into_owned(),
    }
}

fn known_editor_candidates(preset: EditorPreset) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let (directory, executable) = match preset {
            EditorPreset::VisualStudioCode => ("Microsoft VS Code", "Code.exe"),
            EditorPreset::Cursor => ("cursor", "Cursor.exe"),
            EditorPreset::System => return candidates,
        };
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join(directory)
                    .join(executable),
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join(directory)
                    .join(executable),
            );
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join(directory)
                    .join(executable),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(match preset {
            EditorPreset::VisualStudioCode => PathBuf::from(
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            ),
            EditorPreset::Cursor => {
                PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")
            }
            EditorPreset::System => return candidates,
        });
    }
    candidates
}

fn editor_program(preset: EditorPreset) -> Result<PathBuf, String> {
    for candidate in known_editor_candidates(preset) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let executable = match preset {
            EditorPreset::VisualStudioCode => "Code.exe",
            EditorPreset::Cursor => "Cursor.exe",
            EditorPreset::System => unreachable!(),
        };
        let output = Command::new("where.exe").arg(executable).output().ok();
        if let Some(output) = output.filter(|output| output.status.success()) {
            if let Some(found) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(PathBuf::from)
                .find(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "exe"))
            {
                return Ok(found);
            }
        }
        Err(format!(
            "{} is not installed or could not be located",
            match preset {
                EditorPreset::VisualStudioCode => "Visual Studio Code",
                EditorPreset::Cursor => "Cursor",
                EditorPreset::System => unreachable!(),
            }
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(PathBuf::from(match preset {
            EditorPreset::VisualStudioCode => "code",
            EditorPreset::Cursor => "cursor",
            EditorPreset::System => unreachable!(),
        }))
    }
}

fn build_command_spec(
    platform: Platform,
    preset: EditorPreset,
    file: &Path,
    line: Option<u32>,
    column: Option<u32>,
    selected_editor: Option<PathBuf>,
) -> Result<CommandSpec, String> {
    if preset == EditorPreset::System {
        let program = match platform {
            Platform::Windows => "explorer.exe",
            Platform::Macos => "open",
            Platform::Linux => "xdg-open",
        };
        return Ok(CommandSpec {
            program: PathBuf::from(program),
            args: vec![file.to_string_lossy().into_owned()],
        });
    }

    let program = selected_editor.ok_or_else(|| "editor executable is unavailable".to_string())?;
    Ok(CommandSpec {
        program,
        args: vec!["--goto".into(), location_arg(file, line, column)],
    })
}

#[tauri::command]
pub fn open_file_in_editor(
    path: String,
    project_root: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    editor: EditorPreset,
) -> Result<(), String> {
    let line = validate_location(line, "line")?;
    let column = validate_location(column, "column")?;
    if column.is_some() && line.is_none() {
        return Err("column requires a line".into());
    }
    let file = resolve_file(&path, project_root.as_deref())?;
    let selected_editor = if editor == EditorPreset::System {
        None
    } else {
        Some(editor_program(editor)?)
    };
    let spec = build_command_spec(
        current_platform(),
        editor,
        &file,
        line,
        column,
        selected_editor,
    )?;
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|e| format!("failed to open {}: {e}", file.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_relative_existing_file() {
        let root = std::env::temp_dir().join(format!("xshell-editor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("a file.rs"), "fn main() {}\n").unwrap();
        let resolved = resolve_file("src/a file.rs", root.to_str()).unwrap();
        assert!(resolved.ends_with(Path::new("src").join("a file.rs")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_or_non_file_paths() {
        let root = std::env::temp_dir().join(format!("xshell-editor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(resolve_file("missing.rs", root.to_str()).is_err());
        assert!(resolve_file(".", root.to_str()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_location_bounds() {
        assert!(validate_location(Some(0), "line").is_err());
        assert!(validate_location(Some(MAX_LOCATION + 1), "column").is_err());
        assert_eq!(validate_location(Some(12), "line").unwrap(), Some(12));
    }

    #[test]
    fn editor_path_is_one_argument_even_with_shell_metacharacters() {
        let path = Path::new("C:\\work\\name & echo owned | file.ts");
        let spec = build_command_spec(
            Platform::Windows,
            EditorPreset::VisualStudioCode,
            path,
            Some(12),
            Some(3),
            Some(PathBuf::from("C:\\Code.exe")),
        )
        .unwrap();
        assert_eq!(spec.program, PathBuf::from("C:\\Code.exe"));
        assert_eq!(spec.args.len(), 2);
        assert_eq!(spec.args[0], "--goto");
        assert_eq!(spec.args[1], "C:\\work\\name & echo owned | file.ts:12:3");
    }

    #[test]
    fn system_open_does_not_use_a_shell() {
        for (platform, program) in [
            (Platform::Windows, "explorer.exe"),
            (Platform::Macos, "open"),
            (Platform::Linux, "xdg-open"),
        ] {
            let spec = build_command_spec(
                platform,
                EditorPreset::System,
                Path::new("/tmp/a file.txt"),
                Some(4),
                Some(2),
                None,
            )
            .unwrap();
            assert_eq!(spec.program, PathBuf::from(program));
            assert_eq!(spec.args, vec!["/tmp/a file.txt"]);
        }
    }
}
