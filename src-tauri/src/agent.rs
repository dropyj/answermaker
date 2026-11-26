//! Local agent CLI integration (CodeMaker / Claude Code / Codex / Gemini).
//!
//! The frontend can select a local agent CLI as the chat model. We detect the
//! binaries, run them non-interactively with a prompt, capture stdout/stderr,
//! strip ANSI escapes and enforce a timeout. Only a fixed whitelist of agent
//! ids is accepted — the frontend cannot execute arbitrary commands.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

#[derive(Debug, Clone, Serialize)]
pub struct AgentCli {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub available: bool,
}

fn which(name: &str) -> Option<String> {
    #[cfg(windows)]
    let out = Command::new("where.exe").arg(name).output();
    #[cfg(not(windows))]
    let out = Command::new("which").arg(name).output();

    out.ok().and_then(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .next()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
    })
}

fn first_existing(candidates: Vec<Option<PathBuf>>) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
}

fn detect(id: &str) -> Option<String> {
    let from_known = match id {
        "codemaker" => first_existing(vec![
            std::env::var_os("USERPROFILE")
                .map(|h| PathBuf::from(h).join(".codemaker").join("bin").join("codemaker.exe")),
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".codemaker").join("bin").join("codemaker")),
        ]),
        "claude" => first_existing(vec![
            std::env::var_os("USERPROFILE")
                .map(|h| PathBuf::from(h).join(".local").join("bin").join("claude.exe")),
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".local").join("bin").join("claude")),
        ]),
        "codex" => first_existing(vec![
            std::env::var_os("APPDATA")
                .map(|h| PathBuf::from(h).join("npm").join("codex.cmd")),
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".local").join("bin").join("codex")),
        ]),
        _ => None,
    };
    from_known.or_else(|| which(id))
}

fn probe_all() -> Vec<AgentCli> {
    let defs = [
        ("codemaker", "CodeMaker"),
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("gemini", "Gemini CLI"),
    ];
    defs.iter()
        .map(|(id, name)| {
            let path = detect(id);
            AgentCli {
                id: id.to_string(),
                name: name.to_string(),
                available: path.is_some(),
                path,
            }
        })
        .collect()
}

#[tauri::command]
pub fn agent_probe() -> Vec<AgentCli> {
    probe_all()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn command_for(
    agent: &str,
    path: &str,
    prompt: &str,
) -> Result<(Command, Option<String>, Option<PathBuf>), String> {
    let is_cmd = path.to_lowercase().ends_with(".cmd") || path.to_lowercase().ends_with(".bat");
    let mut cmd;
    let stdin_prompt;
    let output_file;

    match agent {
        "codemaker" => {
            cmd = Command::new(path);
            cmd.args(["run", prompt]);
            stdin_prompt = None;
            output_file = None;
        }
        "claude" => {
            // 通过 stdin 传 prompt，避免 shell/cmd 对特殊字符的二次解析
            cmd = Command::new(path);
            cmd.arg("-p");
            stdin_prompt = Some(prompt.to_string());
            output_file = None;
        }
        "codex" => {
            // -o 只输出最后一条 assistant 消息，避免把整个执行日志塞进聊天区
            let file = std::env::temp_dir().join(format!(
                "answermaker-codex-{}-{}.txt",
                std::process::id(),
                now_millis()
            ));
            let file_arg = file.to_string_lossy().to_string();
            if is_cmd {
                cmd = Command::new("cmd");
                cmd.arg("/C").arg(path);
            } else {
                cmd = Command::new(path);
            }
            cmd.args(["exec", "--skip-git-repo-check", "-o", &file_arg, "-"]);
            stdin_prompt = Some(prompt.to_string());
            output_file = Some(file);
        }
        "gemini" => {
            cmd = Command::new(path);
            cmd.args(["-p", prompt]);
            stdin_prompt = None;
            output_file = None;
        }
        _ => return Err(format!("不支持的 Agent：{agent}")),
    }

    hide(&mut cmd);
    Ok((cmd, stdin_prompt, output_file))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// CodeMaker 的终端 UI 会输出 `> build · model` 之类的行；聊天区只保留正文。
fn strip_cli_ui(text: &str) -> String {
    text.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('>') && !t.starts_with("build ·")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn run_with_timeout(
    mut cmd: Command,
    stdin_prompt: Option<String>,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    cmd.stdin(if stdin_prompt.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Agent CLI 失败：{e}"))?;

    if let Some(prompt) = stdin_prompt {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }
    }

    let mut stdout = child.stdout.take().ok_or("无法读取 Agent 输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取 Agent 错误输出")?;
    let out_handle = thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_handle = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Agent 执行超时（{} 秒），已终止",
                        timeout.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("等待 Agent 退出失败：{e}")),
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok((status.success(), strip_ansi(&stdout), strip_ansi(&stderr)))
}

fn run_agent(agent: String, prompt: String, cwd: Option<String>) -> Result<String, String> {
    let cli = probe_all()
        .into_iter()
        .find(|c| c.id == agent)
        .ok_or_else(|| format!("未知 Agent：{agent}"))?;
    let path = cli
        .path
        .ok_or_else(|| format!("未检测到 {}，请先安装并登录该 CLI", cli.name))?;

    let (mut cmd, stdin_prompt, output_file) = command_for(&agent, &path, &prompt)?;
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    let (ok, stdout, stderr) = run_with_timeout(cmd, stdin_prompt, Duration::from_secs(240))?;

    // Codex：优先读 -o 指定的最后一条消息文件
    let from_file = output_file.and_then(|p| {
        let text = std::fs::read_to_string(&p).ok();
        let _ = std::fs::remove_file(&p);
        text.filter(|s| !s.trim().is_empty())
    });
    let mut text = from_file.unwrap_or(stdout);
    if agent == "codemaker" {
        text = strip_cli_ui(&text);
    }
    let text = text.trim();

    if !ok && text.is_empty() {
        return Err(format!(
            "{} 执行失败：{}",
            cli.name,
            stderr.trim().chars().take(600).collect::<String>()
        ));
    }
    if text.is_empty() {
        let err = stderr.trim();
        if !err.is_empty() {
            return Err(format!(
                "{} 没有返回内容：{}",
                cli.name,
                err.chars().take(600).collect::<String>()
            ));
        }
        return Err(format!("{} 没有返回内容", cli.name));
    }
    Ok(text.chars().take(200_000).collect())
}

#[tauri::command]
pub async fn agent_run(
    agent: String,
    prompt: String,
    cwd: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_agent(agent, prompt, cwd))
        .await
        .map_err(|e| format!("Agent 后台任务失败：{e}"))?
}
