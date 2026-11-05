// Quack Presence: o ícone na bandeja, o painel e a janela de configurações.
//
// Quem faz o trabalho é o presence.mjs, que abre este exe como filho e passa a pasta dele em
// --dir. O protocolo é o mesmo do tray.ps1 que este app substitui: comandos em linhas no stdout
// (input N, quit, reconnect, config {json}) e o estado lido de presence.status.json. O fim do
// stdin quer dizer que o Node morreu, e então este processo sai junto.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, RunEvent, WebviewWindow, WindowEvent};

const TRAY_ID: &str = "quack-presence";
const TRAY_WIDTH: f64 = 320.0;
/** Espaço entre o painel e a barra de tarefas, em pixels físicos */
const TRAY_GAP: f64 = 10.0;
/** O mesmo ritmo do tray.ps1: o presence.mjs conta com o input a cada ~2 s para o "longe do PC" */
const POLL_EVERY: Duration = Duration::from_millis(2000);

const ICON_OK: &[u8] = include_bytes!("../tray/ok.png");
const ICON_PARADO: &[u8] = include_bytes!("../tray/parado.png");
const ICON_ERRO: &[u8] = include_bytes!("../tray/erro.png");

struct Shared {
    dir: PathBuf,
    /** O que as janelas mostram, o último calculado pelo poll */
    view: Mutex<Value>,
    /** Onde o ícone foi clicado por último: x, y, largura, altura em pixels físicos */
    tray_rect: Mutex<Option<(f64, f64, f64, f64)>>,
    tray_hidden_at: Mutex<Option<Instant>>,
    icon: Mutex<&'static str>,
    stdout: Mutex<std::io::Stdout>,
}

fn send(app: &AppHandle, line: &str) {
    let shared = app.state::<Shared>();
    let mut out = shared.stdout.lock().unwrap();
    // Um pai que já foi embora fecha o pipe: o fim do stdin encerra este processo logo depois.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn startup_link() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup\quack-presence.vbs"))
}

/** Nome do tipo de atividade do Discord, como o card mostra */
fn tipo_nome(tipo: i64) -> &'static str {
    match tipo {
        0 => "Jogando",
        2 => "Ouvindo",
        3 => "Assistindo",
        5 => "Competindo",
        _ => "",
    }
}

/**
 * O estado que o painel e o ícone mostram, a partir do presence.status.json e da hora. É o
 * Update-Status do tray.ps1: programa sem resposta passa de 3 intervalos (no mínimo 5 s) mais 10 s.
 */
fn status_view(status: Option<&Value>, now: f64) -> Value {
    let (nivel, estado, mut linha1, mut linha2, tipo) = match status {
        None => ("erro", "O programa não está respondendo".to_string(), String::new(), String::new(), ""),
        Some(s) => {
            let intervalo = s["intervalo"].as_f64().unwrap_or(5.0).max(5.0);
            let limite = 3.0 * intervalo * 1000.0 + 10_000.0;
            let at = s["at"].as_f64().unwrap_or(0.0);
            if now - at > limite {
                ("erro", "O programa não está respondendo".to_string(), String::new(), String::new(), "")
            } else if s["pausado"].as_bool() == Some(true) {
                // Antes do Discord: desligado, o Discord fora não é um problema a mostrar
                ("parado", "Desligado, sem card no Discord".to_string(), String::new(), String::new(), "")
            } else if s["discord"].as_bool() != Some(true) {
                ("erro", "Discord não conectado".to_string(), String::new(), String::new(), "")
            } else if s["t3"].as_bool() != Some(true) {
                ("parado", "T3 Code fechado, card limpo".to_string(), String::new(), String::new(), "")
            } else if !s["card"].is_object() {
                ("parado", "Ocioso, card escondido".to_string(), String::new(), String::new(), "")
            } else {
                let card = &s["card"];
                let tipo = tipo_nome(card["tipo"].as_i64().unwrap_or(-1));
                // O nome do app já está no topo do painel e no card: aqui só o estado
                let estado = "Card no Discord".to_string();
                let l1 = card["linha1"].as_str().unwrap_or("").to_string();
                let l2 = card["linha2"].as_str().unwrap_or("").to_string();
                ("ok", estado, l1, l2, tipo)
            }
        }
    };
    let erro = status.and_then(|s| s["erro"].as_str()).unwrap_or("");
    let pausado = nivel == "parado" && status.is_some_and(|s| s["pausado"].as_bool() == Some(true));
    if !erro.is_empty() && nivel != "ok" && !pausado {
        linha1 = erro.to_string();
        linha2 = String::new();
    }
    json!({
        "nivel": nivel,
        "estado": estado,
        "tipo": tipo,
        "linha1": linha1,
        "linha2": linha2,
        "app": status.and_then(|s| s["app"].as_str()).unwrap_or(""),
        "modo": status.and_then(|s| s["modo"].as_str()).unwrap_or(""),
    })
}

/** Texto do ícone: o card quando há um, senão o estado. O Windows corta a dica em 127 caracteres. */
fn tooltip_for(view: &Value) -> String {
    let l1 = view["linha1"].as_str().unwrap_or("");
    let l2 = view["linha2"].as_str().unwrap_or("");
    let body = match (l1.is_empty(), l2.is_empty()) {
        (true, true) => view["estado"].as_str().unwrap_or("").to_string(),
        (false, true) => l1.to_string(),
        (true, false) => l2.to_string(),
        (false, false) => format!("{l1} · {l2}"),
    };
    clip_utf16(&format!("Quack Presence: {body}"), TOOLTIP_UTF16)
}

/** O szTip do Windows tem 128 unidades UTF-16 com o terminador; um emoji conta duas */
const TOOLTIP_UTF16: usize = 120;

/** Corta em `max` unidades UTF-16 (o "…" incluso) sem partir um caractere ao meio */
fn clip_utf16(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        if used + c.len_utf16() > max - 1 {
            break;
        }
        used += c.len_utf16();
        out.push(c);
    }
    out + "…"
}

/** Tudo que as janelas precisam: o estado, o config.json (ou o erro dele) e o início com o Windows */
fn build_view(dir: &Path) -> Value {
    let status = read_json(&dir.join("presence.status.json"));
    let mut view = status_view(status.as_ref(), now_ms());
    let config_text = fs::read_to_string(dir.join("config.json"));
    let config = config_text
        .as_ref()
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        // Um JSON válido que não é objeto (null, uma lista) também não serve de config
        .filter(Value::is_object);
    view["configOk"] = json!(config.is_some());
    view["config"] = config.unwrap_or(Value::Null);
    view["iniciarComWindows"] = json!(startup_link().is_some_and(|p| p.exists()));
    // Os projetos do T3 que o presence.mjs leu, para a lista de projetos das configurações
    view["projetos"] = status
        .as_ref()
        .and_then(|s| s.get("projetos"))
        .filter(|p| p.is_array())
        .cloned()
        .unwrap_or(json!([]));
    view
}

// ---------- ociosidade do teclado e do mouse, para o "longe do PC" ----------

#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

#[link(name = "user32")]
extern "system" {
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

/** Milissegundos desde o último teclado ou mouse. wrapping: o contador dá a volta em 49,7 dias. */
fn idle_ms() -> Option<u32> {
    let mut info = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
    // SAFETY: a struct tem o layout de LASTINPUTINFO e cb_size certo; as duas funções não guardam o ponteiro.
    unsafe {
        if GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        Some(GetTickCount().wrapping_sub(info.dw_time))
    }
}

// ---------- comandos das janelas ----------

#[tauri::command]
fn get_view(app: AppHandle) -> Value {
    app.state::<Shared>().view.lock().unwrap().clone()
}

/** Um pedaço do config.json: quem grava é o presence.mjs, trocando só os valores no texto */
#[tauri::command]
fn send_config(app: AppHandle, patch: Map<String, Value>) {
    send(&app, &format!("config {}", Value::Object(patch)));
    refresh_soon(app);
}

#[tauri::command]
fn reconnect(app: AppHandle) {
    send(&app, "reconnect");
    refresh_soon(app);
}

#[tauri::command]
fn set_startup(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let link = startup_link().ok_or("pasta Inicializar não encontrada")?;
    if enabled && !link.exists() {
        let dir = &app.state::<Shared>().dir;
        fs::copy(dir.join("start-hidden.vbs"), &link).map_err(|e| e.to_string())?;
    } else if !enabled && link.exists() {
        fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    Ok(link.exists())
}

/** config.json ou presence.log no programa padrão do Windows, como o Invoke-Item fazia */
#[tauri::command]
fn open_file(app: AppHandle, which: String) -> Result<(), String> {
    let name = match which.as_str() {
        "config" => "config.json",
        "log" => "presence.log",
        _ => return Err("arquivo desconhecido".into()),
    };
    let path = app.state::<Shared>().dir.join(name);
    if !path.exists() {
        return Err(format!("{name} ainda não existe"));
    }
    // O explorer abre no programa associado; sem associação, ele pergunta qual usar.
    Command::new("explorer.exe").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_settings(app: AppHandle) {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    show_settings_window(&app);
}

#[tauri::command]
fn tray_fit(app: AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("tray") {
        let _ = window.set_size(LogicalSize::new(TRAY_WIDTH, height.clamp(120.0, 720.0)));
        place_tray(&app, &window);
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    // O presence.mjs limpa o card e sai; este processo não espera por isso.
    send(&app, "quit");
    app.exit(0);
}

fn show_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = app.emit_to("settings", "settings-shown", ());
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/** Depois de um comando, o painel mostra o efeito sem esperar o ciclo seguinte inteiro */
fn refresh_soon(app: AppHandle) {
    thread::spawn(move || {
        for wait in [400, 1200] {
            thread::sleep(Duration::from_millis(wait));
            refresh(&app);
        }
    });
}

fn refresh(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let view = build_view(&shared.dir);
    let nivel = match view["nivel"].as_str() {
        Some("ok") => "ok",
        Some("parado") => "parado",
        _ => "erro",
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let mut icon = shared.icon.lock().unwrap();
        if *icon != nivel {
            let bytes = match nivel {
                "ok" => ICON_OK,
                "parado" => ICON_PARADO,
                _ => ICON_ERRO,
            };
            if let Ok(image) = Image::from_bytes(bytes) {
                let _ = tray.set_icon(Some(image));
                *icon = nivel;
            }
        }
        let _ = tray.set_tooltip(Some(tooltip_for(&view)));
    }
    let mut last = shared.view.lock().unwrap();
    if *last != view {
        *last = view.clone();
        let _ = app.emit("view", view);
    }
}

fn poll_loop(app: AppHandle) {
    loop {
        if let Some(ms) = idle_ms() {
            send(&app, &format!("input {ms}"));
        }
        refresh(&app);
        thread::sleep(POLL_EVERY);
    }
}

/** Fica lendo o stdin até o fim: o pipe fecha quando o presence.mjs morre, de qualquer jeito */
fn parent_watch(app: AppHandle) {
    let mut buf = [0u8; 256];
    let mut stdin = std::io::stdin();
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    app.exit(0);
}

// ---------- posição do painel (a mesma do Quack) ----------

/** Em cima do ícone (ou embaixo, com a barra de tarefas no topo), sem sair do monitor */
fn place_tray(app: &AppHandle, window: &WebviewWindow) {
    let Some((ix, iy, iw, ih)) = *app.state::<Shared>().tray_rect.lock().unwrap() else { return };
    let Ok(size) = window.outer_size() else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let monitor = app.monitor_from_point(ix + iw / 2.0, iy + ih / 2.0).ok().flatten();
    let (mx, my, mw, mh) = match &monitor {
        Some(m) => {
            let area = m.work_area();
            (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64)
        }
        None => (0.0, 0.0, f64::MAX, f64::MAX),
    };
    let (x, y) = tray_position((ix, iy, iw, ih), (w, h), (mx, my, mw, mh));
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/** Posição do painel para o retângulo do ícone, o tamanho do painel e a área do monitor (x, y, w, h) */
fn tray_position(icon: (f64, f64, f64, f64), panel: (f64, f64), area: (f64, f64, f64, f64)) -> (f64, f64) {
    let (ix, iy, iw, ih) = icon;
    let (w, h) = panel;
    let (mx, my, mw, mh) = area;
    // clamp entra em pânico quando os limites se cruzam, o que acontece numa área mais estreita
    // (ou mais baixa) que o painel: o limite de cima nunca fica abaixo do de baixo
    let x_low = mx + TRAY_GAP;
    let x = (ix + iw / 2.0 - w / 2.0).clamp(x_low, (mx + mw - w - TRAY_GAP).max(x_low));
    let below = iy < my + mh / 2.0;
    let y = if below { iy + ih + TRAY_GAP } else { iy - h - TRAY_GAP };
    let y = y.clamp(my, (my + mh - h).max(my));
    (x, y)
}

/** Os dois botões abrem o painel, ao soltar, como os ícones da própria barra de tarefas */
fn opens_tray_panel(event: &TrayIconEvent) -> Option<Rect> {
    match event {
        TrayIconEvent::Click { button: MouseButton::Left | MouseButton::Right, button_state: MouseButtonState::Up, rect, .. } => Some(*rect),
        _ => None,
    }
}

fn toggle_tray(app: &AppHandle, rect: (f64, f64, f64, f64)) {
    let Some(window) = app.get_webview_window("tray") else { return };
    let shared = app.state::<Shared>();
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    // Clicar no ícone com o painel aberto primeiro tira o foco dele, o que já o esconde: esse
    // clique não pode abrir de novo
    if shared.tray_hidden_at.lock().unwrap().is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    *shared.tray_rect.lock().unwrap() = Some(rect);
    place_tray(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to("tray", "tray-shown", ());
}

/** A pasta do presence.mjs: --dir, senão a pasta atual */
fn dir_from_args(args: &[String]) -> PathBuf {
    args.iter()
        .position(|a| a == "--dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_panel_sits_above_a_bottom_taskbar_and_stays_on_screen() {
        let (x, y) = tray_position((2400.0, 1400.0, 24.0, 24.0), (320.0, 500.0), (0.0, 0.0, 2560.0, 1392.0));
        assert_eq!(y, 1400.0 - 500.0 - TRAY_GAP);
        assert!(x + 320.0 <= 2560.0 - TRAY_GAP + 0.001, "dentro da borda direita");
    }

    #[test]
    fn tray_panel_on_a_work_area_narrower_than_itself_does_not_panic() {
        let (x, y) = tray_position((100.0, 700.0, 24.0, 24.0), (400.0, 500.0), (0.0, 0.0, 300.0, 400.0));
        assert_eq!(x, TRAY_GAP);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn a_right_click_opens_the_panel_too_and_only_on_release() {
        let click = |button, button_state| TrayIconEvent::Click {
            id: TRAY_ID.into(),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        };
        assert!(opens_tray_panel(&click(MouseButton::Right, MouseButtonState::Up)).is_some());
        assert!(opens_tray_panel(&click(MouseButton::Left, MouseButtonState::Up)).is_some());
        assert!(opens_tray_panel(&click(MouseButton::Left, MouseButtonState::Down)).is_none());
        assert!(opens_tray_panel(&click(MouseButton::Middle, MouseButtonState::Up)).is_none());
    }

    #[test]
    fn the_status_reads_like_the_old_tray() {
        let now = 1_000_000.0;
        let base = json!({ "t3": true, "discord": true, "app": "StarX Studio", "intervalo": 5, "at": now - 1000.0,
            "card": { "tipo": 3, "linha1": "Programando · Quack", "linha2": "Editando código" } });
        let v = status_view(Some(&base), now);
        assert_eq!(v["nivel"], "ok");
        assert_eq!(v["estado"], "Card no Discord");
        assert_eq!(v["app"], "StarX Studio");
        assert_eq!(v["tipo"], "Assistindo");
        assert_eq!(v["linha2"], "Editando código");

        // 3 x 5 s + 10 s = 25 s sem escrever: programa sem resposta
        let mut old = base.clone();
        old["at"] = json!(now - 26_000.0);
        assert_eq!(status_view(Some(&old), now)["nivel"], "erro");
        old["at"] = json!(now - 24_000.0);
        assert_eq!(status_view(Some(&old), now)["nivel"], "ok", "ainda dentro do limite");

        let mut idle = base.clone();
        idle["card"] = Value::Null;
        assert_eq!(status_view(Some(&idle), now)["estado"], "Ocioso, card escondido");
        let mut closed = base.clone();
        closed["t3"] = json!(false);
        assert_eq!(status_view(Some(&closed), now)["nivel"], "parado");

        let mut paused = base.clone();
        paused["pausado"] = json!(true);
        paused["discord"] = json!(false);
        paused["erro"] = json!("Discord fechado ou sem resposta");
        let v = status_view(Some(&paused), now);
        assert_eq!((v["nivel"].as_str(), v["estado"].as_str()), (Some("parado"), Some("Desligado, sem card no Discord")));
        assert_eq!(v["linha1"], "", "desligado não mostra card");

        let mut off = base.clone();
        off["discord"] = json!(false);
        off["erro"] = json!("Discord fechado ou sem resposta");
        let v = status_view(Some(&off), now);
        assert_eq!(v["nivel"], "erro");
        assert_eq!(v["linha1"], "Discord fechado ou sem resposta", "o erro aparece no lugar do card");
        assert_eq!(status_view(None, now)["estado"], "O programa não está respondendo");
    }

    #[test]
    fn the_tooltip_fits_what_windows_shows() {
        let long = "x".repeat(300);
        let tip = tooltip_for(&json!({ "estado": "", "linha1": long, "linha2": "y" }));
        assert!(tip.encode_utf16().count() <= TOOLTIP_UTF16);
        // Emoji contam duas unidades: o corte segue o limite do Windows e não parte nenhum ao meio
        let tip = tooltip_for(&json!({ "estado": "", "linha1": "🦫".repeat(100), "linha2": "" }));
        assert!(tip.encode_utf16().count() <= TOOLTIP_UTF16, "{}", tip.encode_utf16().count());
        assert!(tip.ends_with('…') && tip.trim_end_matches('…').ends_with('🦫'));
        assert_eq!(tooltip_for(&json!({ "estado": "x", "linha1": "", "linha2": "Revisando" })), "Quack Presence: Revisando", "só a linha 2");
        assert_eq!(tooltip_for(&json!({ "estado": "Ocioso, card escondido", "linha1": "", "linha2": "" })), "Quack Presence: Ocioso, card escondido");
    }

    #[test]
    fn the_folder_comes_from_dir() {
        let args: Vec<String> = ["exe", "--dir", r"E:\Documents\Dev\Quack Presence"].iter().map(|s| s.to_string()).collect();
        assert_eq!(dir_from_args(&args), PathBuf::from(r"E:\Documents\Dev\Quack Presence"));
    }

    #[test]
    fn a_config_that_is_not_an_object_counts_as_broken() {
        let dir = std::env::temp_dir().join(format!("t3p-view-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for (text, ok) in [("null", false), ("[1]", false), ("{nope", false), (r#"{"modoAtivo":"normal"}"#, true)] {
            fs::write(dir.join("config.json"), text).unwrap();
            assert_eq!(build_view(&dir)["configOk"], ok, "{text}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_idle_time_reads() {
        assert!(idle_ms().is_some());
    }

    #[test]
    fn the_panel_and_the_window_keep_every_action_the_old_menu_had() {
        let tray = include_str!("../../ui/tray.js");
        let settings = include_str!("../../ui/settings.js");
        for call in [r#""quit""#, r#""reconnect""#, r#""show_settings""#, r#"which: "config""#, r#"which: "log""#, r#""send_config""#] {
            assert!(tray.contains(call), "painel sem {call}");
        }
        for key in ["modoAtivo", "mostrar", "tipo", "quandoOcioso", "ociosoMinutos", "ausenteMinutos", "intervaloSegundos", "seguirUltimaMensagem", "set_startup"] {
            assert!(settings.contains(key), "configurações sem {key}");
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = dir_from_args(&args);
    let shared = Shared {
        dir: dir.clone(),
        // Já preenchido: as janelas carregam antes do primeiro ciclo do poll e pedem o estado na hora
        view: Mutex::new(build_view(&dir)),
        tray_rect: Mutex::new(None),
        tray_hidden_at: Mutex::new(None),
        icon: Mutex::new(""),
        stdout: Mutex::new(std::io::stdout()),
    };
    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![get_view, send_config, reconnect, set_startup, open_file, show_settings, tray_fit, quit])
        .setup(move |app| {
            // Sem menu nativo, como no Quack: o Windows abre ele sob o cursor, por cima da barra
            // de tarefas, e um jogo em tela cheia o cobre. Sair fica no painel.
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(ICON_PARADO)?)
                .tooltip("Quack Presence")
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                        // O duplo clique abria as configurações no tray.ps1; os dois cliques
                        // simples antes dele já abriram e fecharam o painel.
                        show_settings(app.clone());
                        return;
                    }
                    if let Some(rect) = opens_tray_panel(&event) {
                        let scale = app.get_webview_window("tray").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                        let position = rect.position.to_physical::<f64>(scale);
                        let size = rect.size.to_physical::<f64>(scale);
                        toggle_tray(app, (position.x, position.y, size.width, size.height));
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            thread::spawn(move || poll_loop(handle));
            let handle = app.handle().clone();
            thread::spawn(move || parent_watch(handle));
            if args.iter().any(|a| a == "--settings") {
                show_settings_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Fechar a janela só a esconde; sair fica no painel
            ("settings", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            ("tray", WindowEvent::Focused(false)) => {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                    *window.app_handle().state::<Shared>().tray_hidden_at.lock().unwrap() = Some(Instant::now());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Quack Presence: a bandeja não abriu")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
