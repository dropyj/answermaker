//! Ollama detection and bootstrap for the local model runtime.
//!
//! - Detect the Ollama binary, models directory and service on 127.0.0.1:11434
//! - Install via winget (Windows) / brew (macOS) when missing
//! - Start `ollama serve` and pull a hardware-appropriate model
//!
//! The frontend orchestrates install → start → pull and polls `ollama_status`
//! for progress. Long operations run on Tauri's blocking thread pool.

use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

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
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub models_dir: String,
    pub models: Vec<String>,
    pub recommended_model: String,
    pub recommended_reason: String,
    pub ram_gb: f64,
    pub vram_gb: f64,
    pub gpu: String,
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

fn find_ollama() -> Option<String> {
    if let Ok(p) = std::env::var("OLLAMA_EXE") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }

    #[cfg(windows)]
    {
        let candidates = [
            std::env::var_os("LOCALAPPDATA")
                .map(|b| PathBuf::from(b).join("Programs").join("Ollama").join("ollama.exe")),
            std::env::var_os("ProgramFiles")
                .map(|b| PathBuf::from(b).join("Ollama").join("ollama.exe")),
        ];
        for c in candidates.into_iter().flatten() {
            if c.exists() {
                return Some(c.to_string_lossy().to_string());
            }
        }
        if let Ok(out) = Command::new("where.exe").arg("ollama").output() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() {
                    return Some(line.to_string());
                }
            }
        }
        None
    }

    #[cfg(not(windows))]
    {
        for name in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"] {
            if std::path::Path::new(name).exists() {
                return Some(name.to_string());
            }
        }
        if let Ok(out) = Command::new("which").arg("ollama").output() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() {
                    return Some(line.to_string());
                }
            }
        }
        None
    }
}

fn models_dir() -> String {
    if let Some(p) = std::env::var_os("OLLAMA_MODELS") {
        return PathBuf::from(p).to_string_lossy().to_string();
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(|h| PathBuf::from(h).join(".ollama").join("models"))
            .unwrap_or_else(|| PathBuf::from(".ollama/models"))
            .to_string_lossy()
            .to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".ollama").join("models"))
            .unwrap_or_else(|| PathBuf::from(".ollama/models"))
            .to_string_lossy()
            .to_string()
    }
}

fn service_running() -> bool {
    let addr: SocketAddr = "127.0.0.1:11434".parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(450)).is_ok()
}

fn list_models(ollama: &str) -> Vec<String> {
    let mut cmd = Command::new(ollama);
    cmd.arg("list");
    hide(&mut cmd);
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .filter_map(|l| l.split_whitespace().next())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn powershell(script: &str) -> String {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script]);
    hide(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn ram_gb() -> f64 {
    #[cfg(windows)]
    {
        if let Ok(bytes) = powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory").parse::<u64>() {
            if bytes > 0 {
                return bytes as f64 / 1024.0 / 1024.0 / 1024.0;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if let Ok(bytes) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                return bytes as f64 / 1024.0 / 1024.0 / 1024.0;
            }
        }
    }
    0.0
}

fn gpu_name() -> String {
    #[cfg(windows)]
    {
        let name = powershell("(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ';'");
        if !name.is_empty() {
            return name;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("system_profiler").arg("SPDisplaysDataType").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().find(|l| l.contains("Chipset Model")) {
                return line.split(':').nth(1).unwrap_or("").trim().to_string();
            }
        }
    }
    String::new()
}

fn vram_gb() -> f64 {
    // NVIDIA 显存最可靠来自 nvidia-smi；其余平台暂时返回 0，按内存推荐。
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    hide(&mut cmd);
    if let Ok(out) = cmd.output() {
        if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
            if let Ok(mib) = first.trim().parse::<f64>() {
                return mib / 1024.0;
            }
        }
    }
    0.0
}

fn recommend(ram: f64, vram: f64) -> (String, String) {    if vram >= 8.0 {
        (
            "qwen2.5:7b".to_string(),
            format!("检测到 {vram:.0}GB 显存 / {ram:.0}GB 内存，7B 可放入 GPU，质量与速度均衡。"),
        )
    } else if vram >= 4.0 {
        (
            "qwen2.5:3b".to_string(),
            format!("检测到 {vram:.0}GB 显存 / {ram:.0}GB 内存，3B 可在 GPU/CPU 混合下流畅运行。"),
        )
    } else if ram >= 16.0 {
        (
            "qwen2.5:3b".to_string(),
            format!("未检测到独立显存，内存 {ram:.0}GB，3B 可 CPU 推理，中文与 RAG 表现较好。"),
        )
    } else {
        (
            "qwen2.5:1.5b".to_string(),
            format!("内存 {ram:.0}GB 偏小，推荐 1.5B，CPU 运行更流畅。"),
        )
    }
}

static HARDWARE: OnceLock<(f64, f64, String)> = OnceLock::new();

/// 硬件信息只探测一次；下载轮询期间会频繁调用 status。
fn hardware() -> &'static (f64, f64, String) {
    HARDWARE.get_or_init(|| (ram_gb(), vram_gb(), gpu_name()))
}

fn status_impl() -> Result<OllamaStatus, String> {
    let installed_path = find_ollama();
    let installed = installed_path.is_some();
    let models = installed_path
        .as_deref()
        .map(list_models)
        .unwrap_or_default();
    let (ram, vram, gpu) = hardware();
    let (recommended_model, recommended_reason) = recommend(*ram, *vram);
    Ok(OllamaStatus {
        installed,
        running: service_running(),
        models_dir: models_dir(),
        models,
        recommended_model,
        recommended_reason,
        ram_gb: (*ram * 10.0).round() / 10.0,
        vram_gb: (*vram * 10.0).round() / 10.0,
        gpu: gpu.clone(),
    })
}

#[tauri::command]
pub async fn ollama_status() -> Result<OllamaStatus, String> {
    blocking(status_impl).await
}

#[derive(Debug, Clone, Serialize)]
pub struct MachineInfo {
    pub total_ram_gb: Option<f64>,
    pub cpu_cores: Option<u32>,
    pub cpu_name: Option<String>,
    pub gpu_name: Option<String>,
    pub gpu_vram_gb: Option<f64>,
    pub free_disk_gb: Option<f64>,
    pub models_dir: String,
}

/// CPU 物理核数与名称：Windows 走 CIM（与 ram_gb/gpu_name 同一套手段）；
/// 其余平台核数用 available_parallelism，名称仅 macOS 取 brand_string。
/// 拿不到一律 None，不编造。
fn cpu_info() -> (Option<u32>, Option<String>) {
    #[cfg(windows)]
    {
        let cores = powershell("(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum")
            .parse::<u32>()
            .ok()
            .filter(|c| *c > 0);
        let name = powershell("(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)");
        let name = if name.is_empty() { None } else { Some(name) };
        return (cores, name);
    }
    #[cfg(not(windows))]
    {
        let cores = std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as u32);
        #[cfg(target_os = "macos")]
        let name = Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .ok()
            .filter(|s| !s.is_empty());
        #[cfg(not(target_os = "macos"))]
        let name: Option<String> = None;
        (cores, name)
    }
}

/// 模型目录所在盘的剩余空间（GB）：目录可能尚不存在，向上取第一个
/// 已存在的祖先目录测其所在盘。Windows 用 DriveInfo，类 Unix 用 df -k。
fn free_disk_gb(dir: &str) -> Option<f64> {
    let mut path = PathBuf::from(dir);
    while !path.exists() {
        if !path.pop() {
            return None;
        }
    }
    #[cfg(windows)]
    {
        let s = path.to_string_lossy().to_string();
        let drive = s.chars().next()?;
        if s.chars().nth(1) != Some(':') {
            return None;
        }
        let script = format!("[System.IO.DriveInfo]::new('{drive}').AvailableFreeSpace");
        let bytes = powershell(&script).parse::<u64>().ok()?;
        return Some(bytes as f64 / 1024.0 / 1024.0 / 1024.0);
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("df")
            .args(["-k", &path.to_string_lossy()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().nth(1)?;
        let avail_kb = line.split_whitespace().nth(3)?.parse::<f64>().ok()?;
        return Some(avail_kb / 1024.0 / 1024.0);
    }
    #[allow(unreachable_code)]
    None
}

fn machine_info_impl() -> Result<MachineInfo, String> {
    // 内存/显存/GPU 名复用 hardware() 的一次性探测，与 ollama_status 同口径。
    let (ram, vram, gpu) = hardware();
    let dir = models_dir();
    let (cores, cpu_name) = cpu_info();
    let round1 = |v: f64| (v * 10.0).round() / 10.0;
    Ok(MachineInfo {
        total_ram_gb: if *ram > 0.0 { Some(round1(*ram)) } else { None },
        cpu_cores: cores,
        cpu_name,
        gpu_name: if gpu.is_empty() { None } else { Some(gpu.clone()) },
        gpu_vram_gb: if *vram > 0.0 { Some(round1(*vram)) } else { None },
        free_disk_gb: free_disk_gb(&dir).map(round1),
        models_dir: dir,
    })
}

#[tauri::command]
pub async fn machine_info() -> Result<MachineInfo, String> {
    blocking(machine_info_impl).await
}

fn install_impl() -> Result<(), String> {
    if find_ollama().is_some() {
        return Ok(());
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "--id",
            "Ollama.Ollama",
            "--exact",
            "--source",
            "winget",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]);
        hide(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("无法调用 winget：{e}。可手动安装：https://ollama.com/download"))?;
        if !out.status.success() || find_ollama().is_none() {
            let detail = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "Ollama 安装失败：{}。可手动安装：https://ollama.com/download",
                detail.chars().take(300).collect::<String>()
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let out = Command::new("brew")
            .args(["install", "ollama"])
            .output()
            .map_err(|e| format!("无法调用 brew：{e}。可手动安装：https://ollama.com/download"))?;
        if !out.status.success() {
            return Err("Ollama 安装失败，可手动安装：https://ollama.com/download".to_string());
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台请手动安装 Ollama：https://ollama.com/download".to_string())
}

#[tauri::command]
pub async fn ollama_install() -> Result<(), String> {
    blocking(install_impl).await
}

#[tauri::command]
pub fn ollama_start() -> Result<(), String> {
    if service_running() {
        return Ok(());
    }
    let exe = find_ollama().ok_or_else(|| "未安装 Ollama".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 Ollama 服务失败：{e}"))
}

#[tauri::command]
pub fn ollama_pull(model: String) -> Result<(), String> {
    let exe = find_ollama().ok_or_else(|| "未安装 Ollama".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(["pull", &model])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动模型下载失败：{e}"))
}
