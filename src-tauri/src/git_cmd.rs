use serde::Serialize;
use tokio::process::Command;

const ALLOWED_READ: &[&str] = &[
    "status", "log", "diff", "branch", "show", "rev-parse", "remote",
];

const ALLOWED_WRITE: &[&str] = &["add", "commit", "checkout", "stash", "pull", "push"];

const BLOCKED_ARGS: &[&str] = &[
    "--force",
    "-f",
    "--hard",
    "--force-with-lease",
    "--no-verify",
];

#[derive(Serialize)]
pub struct GitResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    /// true if this was a write subcommand (frontend should have confirmed first)
    pub is_write: bool,
}

#[tauri::command]
pub async fn git_execute(
    cwd: String,
    subcommand: String,
    args: Vec<String>,
) -> Result<GitResult, String> {
    let sub = subcommand.as_str();

    let is_read = ALLOWED_READ.contains(&sub);
    let is_write = ALLOWED_WRITE.contains(&sub);
    if !is_read && !is_write {
        return Err(format!("Git subcommand '{}' is not allowed", sub));
    }

    // Block dangerous arguments
    for arg in &args {
        let lower = arg.to_lowercase();
        if BLOCKED_ARGS.contains(&lower.as_str()) {
            return Err(format!("Argument '{}' is blocked for safety", arg));
        }
    }

    // Block rebase entirely via args check (e.g. `git checkout` with rebase intent is fine,
    // but we don't allow `rebase` as a subcommand at all via the whitelist)

    let output = Command::new("git")
        .arg(&subcommand)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok(GitResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        is_write,
    })
}
