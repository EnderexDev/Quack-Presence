// O instalador próprio, a atualização e o lançador, no molde do instalador do Quackify
// (Quackify/src-tauri/src/setup.rs). O NSIS que o Tauri gera continua fazendo a instalação
// (arquivos, registro, desinstalador, atalho do Iniciar), rodado em silêncio:
// - Quack-Presence-Setup.exe é este exe com o NSIS anexado (scripts/release.mjs) e um trailer com
//   o tamanho dele: achando o trailer no próprio arquivo, o exe abre a janela de instalação.
// - Uma atualização: a bandeja copia este exe para a pasta temp como Quack-Presence-Updater.exe,
//   abre a cópia com --quack-update <pasta> e manda o presence.mjs sair. A cópia baixa a versão
//   nova (a assinatura conferida com a chave do tauri.conf.json), roda o NSIS com /UPDATE /R e o
//   NSIS abre o Quack Presence de novo. Da pasta temp, porque o NSIS sobrescreve a pasta
//   instalada, e com outro nome, porque o NSIS fecha todo quack-presence-tray.exe antes.
// - Aberto sem --dir (atalho do Iniciar, o /R do NSIS, a pasta Inicializar), o exe é o lançador:
//   abre o node presence.mjs escondido e sai. O presence.mjs abre este exe de novo, com --dir.
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "setup";
/** O fim do Quack-Presence-Setup.exe: o tamanho do instalador (u64, little endian), depois isto */
const MAGIC: &[u8; 8] = b"QPSETUP1";
const UPDATE_ARG: &str = "--quack-update";
const UPDATER_EXE: &str = "Quack-Presence-Updater.exe";
/** O binário que o NSIS instala (o nome do crate) */
pub const BINARY: &str = "quack-presence-tray.exe";
const PRODUCT: &str = "Quack Presence";
/** A trava de instância única do presence.mjs, que também aceita "quit" */
const LOCK_PIPE: &str = r"\\.\pipe\quack-presence-lock";
/** O node:sqlite que o presence.mjs usa funciona sem --experimental-sqlite a partir do Node 22.13 */
const NODE_MIN: (u32, u32) = (22, 13);

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

pub enum Mode {
    /** Quack-Presence-Setup.exe: o instalador começa tantos bytes antes do fim do exe */
    Install { offset: u64, len: u64 },
    /** A cópia na pasta temp, atualizando o Quack Presence instalado em `dir` */
    Update { dir: PathBuf },
}

/** Para que esta abertura do exe serve, lido antes de qualquer outra coisa */
pub fn mode(args: &[String]) -> Option<Mode> {
    if let Some(i) = args.iter().position(|a| a == UPDATE_ARG) {
        return args.get(i + 1).map(|dir| Mode::Update { dir: PathBuf::from(dir) });
    }
    let exe = std::env::current_exe().ok()?;
    trailer(&exe)
}

fn trailer(exe: &Path) -> Option<Mode> {
    let mut file = File::open(exe).ok()?;
    let size = file.metadata().ok()?.len();
    if size < 16 {
        return None;
    }
    let mut tail = [0u8; 16];
    file.seek(SeekFrom::End(-16)).ok()?;
    file.read_exact(&mut tail).ok()?;
    if &tail[8..] != MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[..8].try_into().ok()?);
    // size >= 16 aqui: a conta não dá a volta, diga o trailer o que disser
    (len > 0 && len <= size - 16).then(|| Mode::Install { offset: size - 16 - len, len })
}

// ---------- lançador ----------

/** A pasta do presence.mjs: a do exe instalado, ou (exe de dev em app/src-tauri/target/release) a de cima */
pub fn find_app_dir(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().skip(1).take(5).find(|d| d.join("presence.mjs").is_file()).map(Path::to_path_buf)
}

/** Abre o node presence.mjs sem janela, solto deste processo, e volta */
pub fn launch() {
    let found = std::env::current_exe().ok().and_then(|exe| find_app_dir(&exe));
    let Some(dir) = found else {
        message_box("O presence.mjs não está na pasta do Quack Presence. Instale de novo.");
        return;
    };
    if node_version().is_none() {
        message_box("O Quack Presence precisa do Node.js 22.13 ou mais novo. Instale pelo nodejs.org e abra de novo.");
        return;
    }
    if let Err(e) = spawn_node(&dir) {
        message_box(&format!("O Quack Presence não abriu: {e}"));
    }
}

fn spawn_node(dir: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    Command::new("node")
        .arg("--no-warnings")
        .arg(dir.join("presence.mjs"))
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
}

/** A versão do node no PATH, se for nova o bastante: "v24.12.0" */
pub fn node_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = Command::new("node").arg("--version").creation_flags(CREATE_NO_WINDOW).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    node_ok(&text).then_some(text)
}

fn node_ok(version: &str) -> bool {
    let mut parts = version.trim_start_matches('v').split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    // O 23 só largou a flag no 23.4, depois do 22.13
    match major {
        23 => minor >= 4,
        _ => (major, minor) >= NODE_MIN,
    }
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

fn message_box(text: &str) {
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(text), wide(PRODUCT));
    // SAFETY: as duas strings terminam em zero e vivem até a função voltar. 0x30: ícone de aviso.
    unsafe {
        MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x30);
    }
}

// ---------- o .vbs da pasta Inicializar ----------

pub fn startup_link() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup\quack-presence.vbs"))
}

/** O script da pasta Inicializar para a pasta `dir`: o mesmo que o start-hidden.vbs fazia */
pub fn startup_script(dir: &Path) -> String {
    let dir = dir.display().to_string().replace('"', "");
    format!(
        "' Inicia o Quack Presence sem janela. Escrito pelo botão \"Iniciar com o Windows\".\r\n\
         dir = \"{dir}\"\r\n\
         CreateObject(\"WScript.Shell\").Run \"node --no-warnings \"\"\" & dir & \"\\presence.mjs\"\"\", 0, False\r\n"
    )
}

/** A pasta para onde o .vbs da pasta Inicializar aponta hoje (a linha dir = "...") */
fn startup_dir() -> Option<PathBuf> {
    let bytes = fs::read(startup_link()?).ok()?;
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let wide: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    dir_from_script(&text)
}

fn dir_from_script(text: &str) -> Option<PathBuf> {
    let line = text.lines().find(|l| l.trim_start().starts_with("dir = \""))?;
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(PathBuf::from(&line[start..end]))
}

/**
 * Numa pasta nova, o config.json da instalação de antes (a do .vbs de início, o checkout de dev
 * até aqui) vem junto: os projetos privados e escondidos dele não podem aparecer no Discord.
 */
fn carry_config(dest: &Path) -> Result<(), String> {
    let target = dest.join("config.json");
    if target.exists() {
        return Ok(());
    }
    let Some(from) = startup_dir() else { return Ok(()) };
    let source = from.join("config.json");
    if !source.is_file() || from.canonicalize().ok() == dest.canonicalize().ok() {
        return Ok(());
    }
    // Por um temporário: uma cópia pela metade nunca vira o config.json (o presence.mjs usaria ela
    // e a próxima instalação pularia a cópia, porque o destino já existe)
    let tmp = dest.join("config.json.tmp");
    fs::copy(&source, &tmp)
        .and_then(|_| fs::rename(&tmp, &target))
        .map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("não deu pra trazer o config.json de {}: {e}", from.display())
        })
}

/** Liga ou desliga o início com o Windows para a pasta `dir`. UTF-16 com BOM: um caminho com acento. */
pub fn set_startup(dir: &Path, enabled: bool) -> Result<bool, String> {
    let link = startup_link().ok_or("pasta Inicializar não encontrada")?;
    if enabled {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(startup_script(dir).encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&link, bytes).map_err(|e| e.to_string())?;
    } else if link.exists() {
        fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    Ok(link.exists())
}

// ---------- parar o que já está aberto ----------

fn lock_held() -> bool {
    // Abrir o pipe só funciona com o servidor dele de pé; a conexão fecha logo depois.
    fs::OpenOptions::new().write(true).open(LOCK_PIPE).is_ok()
}

#[link(name = "kernel32")]
extern "system" {
    fn GetNamedPipeServerProcessId(pipe: isize, pid: *mut u32) -> i32;
}

/**
 * Fecha o Quack Presence aberto (instalado ou de dev): "quit" na trava do presence.mjs, que limpa
 * o card e sai. Um presence.mjs de antes desse comando ignora o "quit" e sai pelo taskkill: o
 * processo é o dono da trava (o servidor do pipe), nunca outro node.
 * Devolve se havia um aberto, para quem chama reabrir ele se a instalação falhar.
 */
fn stop_running() -> bool {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    let Ok(mut pipe) = fs::OpenOptions::new().write(true).open(LOCK_PIPE) else { return false };
    let mut pid = 0u32;
    // SAFETY: o handle é do pipe aberto acima e vive até o drop; a função só escreve no u32.
    let got_pid = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as isize, &mut pid) } != 0;
    let _ = pipe.write_all(b"quit\n");
    drop(pipe);
    if wait_for(|| !lock_held(), Duration::from_secs(5)) || !got_pid || pid == 0 {
        return true;
    }
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    wait_for(|| !lock_held(), Duration::from_secs(5));
    true
}

fn wait_for(done: impl Fn() -> bool, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    done()
}

// ---------- NSIS ----------

/**
 * Grava `bytes` em `path` e roda como NSIS, o arquivo preso para nada trocar ou apagar ele no meio:
 * reaberto só com leitura compartilhada (o Windows ainda roda) e comparado com `bytes`.
 */
fn install_from(path: &Path, bytes: &[u8], flags: &[&str], dir: &Path) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("não deu pra gravar o instalador: {e}"))?;
    let result = (|| {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ só: nada escreve nem apaga enquanto este handle vive
        let mut held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1)
            .open(path)
            .map_err(|e| format!("não deu pra abrir o instalador: {e}"))?;
        let mut on_disk = Vec::with_capacity(bytes.len());
        held.read_to_end(&mut on_disk).map_err(|e| format!("não deu pra ler o instalador: {e}"))?;
        if on_disk != bytes {
            return Err("o instalador mudou no disco antes de rodar".to_string());
        }
        run_nsis(path, flags, dir)
    })();
    let _ = fs::remove_file(path);
    result
}

fn run_nsis(installer: &Path, flags: &[&str], dir: &Path) -> Result<(), String> {
    // /D= tem que ser o último argumento e sem aspas, com espaços e tudo: o NSIS lê o resto da
    // linha como a pasta. raw_arg impede o Rust de pôr aspas.
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(installer);
    cmd.arg("/S").args(flags);
    cmd.raw_arg(format!("/D={}", dir.display()));
    let status = cmd.status().map_err(|e| format!("o instalador não abriu: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("o instalador parou com o código {}", status.code().unwrap_or(-1)))
    }
}

// ---------- a janela de instalação ----------

/** Roda a janela de instalação ou a atualização no lugar do app: sem bandeja nem presence.mjs */
pub fn run(mut context: tauri::Context<tauri::Wry>, mode: Mode) {
    // Só a janela do instalador: as do app ficam sem fazer
    context.config_mut().app.windows.clear();
    let updating = matches!(mode, Mode::Update { .. });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(mode)
        .setup(move |app| {
            if updating {
                // A atualização não abre janela: o Quack Presence volta sozinho em alguns segundos
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let dir = match handle.state::<Mode>().inner() {
                        Mode::Update { dir } => dir.clone(),
                        Mode::Install { .. } => unreachable!(),
                    };
                    if let Err(e) = update(&handle, &dir).await {
                        // Sem a versão nova, a velha volta: o card não pode sumir de vez
                        update_log(&dir, &format!("a atualização falhou: {e}"));
                        let _ = Command::new(dir.join(BINARY)).spawn();
                    }
                    handle.exit(0);
                });
                return Ok(());
            }
            // Dados próprios do WebView2: a instalação pode rodar com o Quack Presence aberto
            let data = std::env::temp_dir().join("Quack-Presence-Setup-WebView");
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("setup.html".into()))
                .title(PRODUCT)
                .inner_size(460.0, 490.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .background_color(tauri::window::Color(13, 11, 8, 255))
                .data_directory(data)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![setup_info, setup_installed, setup_pick_folder, setup_install, setup_launch, setup_close])
        .run(context)
        .expect("Quack Presence: o instalador não abriu");
}

/** A pasta da última instalação (a chave que o NSIS grava), ou %LOCALAPPDATA%\Quack Presence */
fn default_dir() -> PathBuf {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(format!(r"Software\enderex\{PRODUCT}")) {
        if let Ok(dir) = key.get_value::<String, _>("") {
            if !dir.is_empty() {
                return PathBuf::from(dir);
            }
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    local.join(PRODUCT)
}

/** async: o `node --version` e o registro rodam fora da thread da janela */
#[tauri::command]
async fn setup_info(app: AppHandle) -> Value {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = default_dir();
        json!({
            "version": version,
            "dir": dir.display().to_string(),
            "installed": dir.join(BINARY).exists(),
            "node": node_version(),
            "nodeMin": format!("{}.{}", NODE_MIN.0, NODE_MIN.1),
            // Ligado por padrão; desligado só quando já há instalação e o .vbs não existe
            "startup": startup_link().is_some_and(|p| p.exists()) || !dir.join(BINARY).exists(),
        })
    })
    .await
    .unwrap_or(Value::Null)
}

#[tauri::command]
fn setup_installed(dir: String) -> bool {
    Path::new(&dir).join(BINARY).exists()
}

#[tauri::command]
async fn setup_pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().clone();
    tauri::async_runtime::spawn_blocking(move || dialog.file().set_title("Onde instalar o Quack Presence").blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        // O NSIS põe os arquivos direto na pasta dada: uma pasta Quack Presence dentro da escolhida
        .map(|p| if p.ends_with(PRODUCT) { p } else { p.join(PRODUCT) })
        .map(|p| p.display().to_string())
}

/** Instala com o NSIS de dentro deste exe. `desktop`: mantém o atalho que o NSIS faz na área de trabalho. */
#[tauri::command]
async fn setup_install(app: AppHandle, dir: String, startup: bool, desktop: bool) -> Result<(), String> {
    let (offset, len) = match app.state::<Mode>().inner() {
        Mode::Install { offset, len } => (*offset, *len),
        Mode::Update { .. } => return Err("não é um instalador".into()),
    };
    if node_version().is_none() {
        return Err(format!("Falta o Node.js {}.{} ou mais novo (nodejs.org)", NODE_MIN.0, NODE_MIN.1));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(dir);
        let shortcut = desktop_shortcut();
        let had_shortcut = shortcut.as_ref().is_some_and(|p| p.exists());
        // A pasta de onde o aberto roda, lida antes do set_startup reescrever o .vbs
        let old_dir = startup_dir().filter(|d| d.join("presence.mjs").is_file());
        // O que está aberto sai antes: o NSIS fecharia a bandeja e deixaria o node sem ela
        let was_running = stop_running();
        let result = (|| {
            let installer = std::env::temp_dir().join(format!("Quack-Presence-Install-{}.exe", std::process::id()));
            let bytes = extract(offset, len)?;
            install_from(&installer, &bytes, &[], &dir)?;
            // Antes do set_startup, que reescreve o .vbs para a pasta nova
            carry_config(&dir)?;
            // O NSIS em silêncio sempre faz o atalho da área de trabalho
            if !desktop && !had_shortcut {
                if let Some(p) = shortcut {
                    let _ = fs::remove_file(p);
                }
            }
            set_startup(&dir, startup).map(|_| ())
        })();
        // Falhou com o Quack Presence fechado por nós: o de antes abre de novo, para o card não sumir
        if result.is_err() && was_running {
            if let Some(old) = old_dir {
                let _ = spawn_node(&old);
            }
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/** O instalador de dentro deste exe */
fn extract(offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut from = File::open(exe).map_err(|e| e.to_string())?;
    from.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(len as usize);
    from.take(len).read_to_end(&mut bytes).map_err(|e| format!("não deu pra ler o instalador: {e}"))?;
    Ok(bytes)
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetKnownFolderPath(id: *const [u8; 16], flags: u32, token: isize, path: *mut *mut u16) -> i32;
}
#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(p: *mut core::ffi::c_void);
}

/** O atalho que o NSIS põe na área de trabalho (a de verdade, mesmo levada para o OneDrive) */
fn desktop_shortcut() -> Option<PathBuf> {
    // FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}, com os três primeiros campos em little endian
    const DESKTOP: [u8; 16] = [0x3A, 0xCC, 0xBF, 0xB4, 0x2C, 0xDB, 0x4C, 0x42, 0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41];
    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: o GUID tem o layout de KNOWNFOLDERID; o texto devolvido termina em zero e é solto com CoTaskMemFree.
    unsafe {
        // O texto é solto até quando a chamada falha, como a documentação pede
        if SHGetKnownFolderPath(&DESKTOP, 0, 0, &mut raw) != 0 || raw.is_null() {
            if !raw.is_null() {
                CoTaskMemFree(raw.cast());
            }
            return None;
        }
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let path = String::from_utf16_lossy(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw.cast());
        Some(PathBuf::from(path).join(format!("{PRODUCT}.lnk")))
    }
}

/** Abre o Quack Presence instalado em `dir` e fecha esta janela */
#[tauri::command]
fn setup_launch(app: AppHandle, dir: String) -> Result<(), String> {
    Command::new(Path::new(&dir).join(BINARY)).spawn().map_err(|e| format!("o Quack Presence não abriu: {e}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn setup_close(app: AppHandle) {
    app.exit(0);
}

// ---------- a atualização ----------

fn update_log(dir: &Path, text: &str) {
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("update.log")) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{now}] {text}");
    }
}

/** A cópia na pasta temp: a versão mais nova do GitHub, baixada e conferida, instalada por cima de `dir` */
async fn update(app: &AppHandle, dir: &Path) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    // O presence.mjs sai pelo "quit" da bandeja; aqui só garante que a trava já soltou
    tauri::async_runtime::spawn_blocking(|| {
        if !wait_for(|| !lock_held(), Duration::from_secs(10)) {
            stop_running();
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("já está na versão mais nova")?;
    update_log(dir, &format!("atualizando para {}", update.version));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let dir = dir.to_path_buf();
    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let installer = std::env::temp_dir().join(format!("Quack-Presence-Update-{version}.exe"));
        // /R: o NSIS abre o Quack Presence de novo no fim (o lançador, sem --dir)
        install_from(&installer, &bytes, &["/UPDATE", "/R"], &dir)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/** Da bandeja: entrega a atualização a uma cópia deste exe na pasta temp. Quem chama manda o presence.mjs sair. */
pub fn hand_off_update(dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let copy = std::env::temp_dir().join(UPDATER_EXE);
    fs::copy(&exe, &copy).map_err(|e| format!("não deu pra copiar o Quack Presence para a atualização: {e}"))?;
    Command::new(&copy)
        .arg(UPDATE_ARG)
        .arg(dir)
        .spawn()
        .map_err(|e| format!("a atualização não abriu: {e}"))?;
    Ok(())
}

/** A cópia que uma atualização deixou na pasta temp (ela não apaga o próprio arquivo) */
pub fn clean_up() {
    let _ = fs::remove_file(std::env::temp_dir().join(UPDATER_EXE));
}

/** Esta é a cópia instalada (a pasta do exe é a do presence.mjs), não um build de dev */
pub fn is_installed(dir: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    exe.parent().is_some_and(|p| same(p, dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_needs_sqlite_without_the_flag() {
        assert!(node_ok("v24.12.0"));
        assert!(node_ok("v22.13.0"));
        assert!(node_ok("v23.4.0"));
        // node:sqlite ainda pedia --experimental-sqlite nestas
        assert!(!node_ok("v22.12.0"));
        assert!(!node_ok("v22.5.0"));
        assert!(!node_ok("v23.3.0"));
        assert!(!node_ok("v20.18.0"));
        assert!(!node_ok(""));
    }

    #[test]
    fn the_startup_script_runs_presence_from_the_folder() {
        let s = startup_script(Path::new(r"C:\Users\Zé\AppData\Local\Quack Presence"));
        assert!(s.contains(r#"dir = "C:\Users\Zé\AppData\Local\Quack Presence""#), "{s}");
        assert!(s.contains(r#"\presence.mjs"#));
    }

    /// Manual (fecha o Quack Presence aberto): um node que segura a trava e ignora o "quit", como
    /// um presence.mjs de antes, tem que sair pelo PID do dono do pipe.
    #[test]
    #[ignore]
    fn an_old_copy_that_ignores_quit_is_stopped_by_its_pipe_pid() {
        let script = r#"require("net").createServer((s) => s.on("error", () => {})).listen("\\\\?\\pipe\\quack-presence-lock"); setInterval(() => {}, 1000);"#;
        let mut child = Command::new("node").args(["-e", script]).spawn().unwrap();
        assert!(wait_for(lock_held, Duration::from_secs(5)), "o falso não pegou a trava");
        let started = Instant::now();
        assert!(stop_running());
        assert!(!lock_held(), "a trava continua presa");
        // O pipe fecha um instante antes do processo terminar de sair
        let gone = (0..25).any(|_| {
            std::thread::sleep(Duration::from_millis(200));
            child.try_wait().unwrap().is_some()
        });
        assert!(gone, "o falso continua vivo");
        assert!(started.elapsed() >= Duration::from_secs(5), "saiu pelo quit, não pelo taskkill");
    }

    #[test]
    fn the_old_folder_is_read_from_the_startup_script() {
        let old = "' Inicia o Quack Presence sem janela.\r\ndir = \"E:\\Documents\\Dev\\Quack Presence\"\r\nCreateObject(...)\r\n";
        assert_eq!(dir_from_script(old), Some(PathBuf::from(r"E:\Documents\Dev\Quack Presence")));
        let new = startup_script(Path::new(r"C:\Users\Zé\AppData\Local\Quack Presence"));
        assert_eq!(dir_from_script(&new), Some(PathBuf::from(r"C:\Users\Zé\AppData\Local\Quack Presence")));
        assert_eq!(dir_from_script("nada aqui"), None);
    }

    #[test]
    fn the_app_folder_is_found_from_a_dev_build_and_an_install() {
        let root = std::env::temp_dir().join(format!("qp-find-{}", std::process::id()));
        let release = root.join(r"app\src-tauri\target\release");
        fs::create_dir_all(&release).unwrap();
        fs::write(root.join("presence.mjs"), "").unwrap();
        assert_eq!(find_app_dir(&release.join(BINARY)), Some(root.clone()));
        assert_eq!(find_app_dir(&root.join(BINARY)), Some(root.clone()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_trailer_finds_the_installer() {
        let path = std::env::temp_dir().join(format!("qp-trailer-{}.exe", std::process::id()));
        let mut bytes = b"EXE-BYTES".to_vec();
        bytes.extend(b"NSIS");
        bytes.extend(4u64.to_le_bytes());
        bytes.extend(MAGIC);
        fs::write(&path, &bytes).unwrap();
        match trailer(&path) {
            Some(Mode::Install { offset, len }) => assert_eq!((offset, len), (9, 4)),
            _ => panic!("sem trailer"),
        }
        fs::write(&path, b"just an exe with no trailer at all").unwrap();
        assert!(trailer(&path).is_none());
        let _ = fs::remove_file(&path);
    }
}
