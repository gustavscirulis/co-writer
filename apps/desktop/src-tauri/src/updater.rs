//! Auto-updater state machine, native menu wiring, and release-check plumbing.
//!
//! All user-facing surfaces stay native. Debug previews share the presenter,
//! but never enter the installation or persisted-dismissal paths.

#[cfg(target_os = "macos")]
mod native;
#[cfg(debug_assertions)]
mod preview;
#[cfg(debug_assertions)]
pub(crate) use preview::{start_preview, PreviewKind};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::MessageDialogButtons;
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Pick a window to anchor native dialogs to. Without a parent, `rfd` falls
/// back to `CFUserNotificationDisplayAlert` on macOS, which shows a generic
/// system icon instead of our app icon. Passing any visible window forces the
/// `NSAlert` path, which displays the running app's icon.
fn dialog_parent(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.values().find(|w| w.is_visible().unwrap_or(false)))
        .cloned()
}

fn with_parent<R: tauri::Runtime>(
    mut builder: MessageDialogBuilder<R>,
    parent: Option<&WebviewWindow<R>>,
) -> MessageDialogBuilder<R> {
    if let Some(parent) = parent {
        builder = builder.parent(parent);
    }
    builder
}

const DAILY_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const DISMISSED_VERSION_FILE: &str = "updater-dismissed-version.json";

/// State machine for the updater lifecycle.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum UpdaterState {
    Idle,
    Checking,
    UpToDate,
    Available { version: String },
    Downloading,
    ReadyToInstall { version: String },
    Error { message: String },
}

/// The lifecycle and pending payload share a lock so admission and consumption
/// are atomic. Generic payloads let tests exercise real sequencing without an
/// updater network client or a running Tauri application.
struct UpdateSession<T> {
    state: UpdaterState,
    pending: Option<T>,
    #[cfg(debug_assertions)]
    preview_active: bool,
}

impl<T> UpdateSession<T> {
    fn new() -> Self {
        Self {
            state: UpdaterState::Idle,
            pending: None,
            #[cfg(debug_assertions)]
            preview_active: false,
        }
    }

    fn is_idle(&self) -> bool {
        #[cfg(debug_assertions)]
        if self.preview_active {
            return false;
        }
        matches!(
            self.state,
            UpdaterState::Idle | UpdaterState::UpToDate | UpdaterState::Error { .. }
        )
    }

    fn begin_check(&mut self) -> bool {
        if !self.is_idle() {
            return false;
        }
        self.state = UpdaterState::Checking;
        true
    }

    fn matches_version(&self, version: &str) -> bool {
        matches!(&self.state, UpdaterState::Available { version: current } if current == version)
    }

    fn take_for_install(&mut self, version: &str) -> Option<T> {
        if !self.matches_version(version) {
            return None;
        }
        let update = self.pending.take()?;
        self.state = UpdaterState::Downloading;
        Some(update)
    }

    fn dismiss(&mut self, version: &str) -> bool {
        if !self.matches_version(version) {
            return false;
        }
        self.pending = None;
        self.state = UpdaterState::Idle;
        true
    }

    #[cfg(debug_assertions)]
    fn begin_preview(&mut self) -> bool {
        if !self.is_idle() {
            return false;
        }
        self.preview_active = true;
        true
    }

    #[cfg(debug_assertions)]
    fn end_preview(&mut self) {
        self.preview_active = false;
    }
}

/// Menu item handles the state machine rebuilds on each transition.
pub struct UpdaterMenuItems {
    pub check: MenuItem<Wry>,
}

/// Application-managed state that owns the updater lifecycle.
pub struct UpdaterManager {
    session: Arc<Mutex<UpdateSession<Update>>>,
    menu_items: UpdaterMenuItems,
    dismissed_version_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct DismissedVersionFile {
    dismissed: Option<String>,
}

impl UpdaterManager {
    pub fn new(menu_items: UpdaterMenuItems, app_data_dir: PathBuf) -> Self {
        let dismissed_version_path = app_data_dir.join(DISMISSED_VERSION_FILE);
        let manager = Self {
            session: Arc::new(Mutex::new(UpdateSession::new())),
            menu_items,
            dismissed_version_path,
        };
        manager.refresh_menu();
        manager
    }

    fn set_state(&self, new: UpdaterState) {
        self.update_session(|session| session.state = new);
    }

    fn update_session<R>(&self, update: impl FnOnce(&mut UpdateSession<Update>) -> R) -> R {
        let result = update(&mut self.session.lock());
        self.refresh_menu();
        result
    }

    /// Atomically transition from a non-busy state to `Checking`. Returns
    /// `false` while a check, prompt, preview or download owns the updater.
    fn try_begin_check(&self) -> bool {
        self.update_session(UpdateSession::begin_check)
    }

    fn refresh_menu(&self) {
        let session = self.session.clone();
        let check = self.menu_items.check.clone();
        // Menu setters dispatch synchronously to the main thread. Never hold
        // the lifecycle lock while dispatching; read the latest state there so
        // queued refreshes cannot restore an older menu state.
        let result = self
            .menu_items
            .check
            .app_handle()
            .run_on_main_thread(move || {
                let (state, preview_active) = {
                    let session = session.lock();
                    #[cfg(debug_assertions)]
                    let preview_active = session.preview_active;
                    #[cfg(not(debug_assertions))]
                    let preview_active = false;
                    (session.state.clone(), preview_active)
                };
                let (check_text, check_enabled) = match &state {
                    UpdaterState::Checking => ("Checking for Updates…".to_string(), false),
                    UpdaterState::Downloading => ("Downloading Update…".to_string(), false),
                    UpdaterState::Available { .. } | UpdaterState::ReadyToInstall { .. } => {
                        ("Check for Updates…".to_string(), false)
                    }
                    _ => ("Check for Updates…".to_string(), true),
                };

                if let Err(error) = check
                    .set_text(check_text)
                    .and_then(|_| check.set_enabled(check_enabled && !preview_active))
                {
                    eprintln!("Could not refresh updater menu: {error}");
                }
            });
        if let Err(error) = result {
            eprintln!("Could not dispatch updater menu refresh: {error}");
        }
    }

    fn read_dismissed_version(&self) -> Option<String> {
        let data = std::fs::read_to_string(&self.dismissed_version_path).ok()?;
        let parsed: DismissedVersionFile = serde_json::from_str(&data).ok()?;
        parsed.dismissed
    }

    fn write_dismissed_version(&self, version: Option<&str>) {
        if let Some(parent) = self.dismissed_version_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = DismissedVersionFile {
            dismissed: version.map(|s| s.to_string()),
        };
        if let Ok(json) = serde_json::to_string(&file) {
            let _ = std::fs::write(&self.dismissed_version_path, json);
        }
    }
}

fn manager(app: &AppHandle) -> tauri::State<'_, UpdaterManager> {
    app.state::<UpdaterManager>()
}

/// Trigger a check for updates. `manual = true` surfaces "up to date" and error
/// dialogs; automatic checks stay quiet when there's nothing to do.
pub fn start_check(app: AppHandle, manual: bool) {
    if !manager(&app).try_begin_check() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let check_result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(err) => Err(err),
        };

        match check_result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let notes = update.body.clone();

                if !manual {
                    let dismissed = manager(&app).read_dismissed_version();
                    if dismissed.as_deref() == Some(version.as_str()) {
                        manager(&app).set_state(UpdaterState::UpToDate);
                        return;
                    }
                }

                {
                    let mgr = manager(&app);
                    mgr.update_session(|session| {
                        session.pending = Some(update);
                        session.state = UpdaterState::Available {
                            version: version.clone(),
                        };
                    });
                }

                prompt_install(app.clone(), version, notes);
            }
            Ok(None) => {
                manager(&app).set_state(UpdaterState::UpToDate);
                if manual {
                    let current = app.package_info().version.to_string();
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(format!(
                                "You're up to date. Co-writer {} is the latest version.",
                                current
                            ))
                            .kind(MessageDialogKind::Info)
                            .title("Co-writer"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                if manual {
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(format!("Could not check for updates.\n\n{}", message))
                            .kind(MessageDialogKind::Error)
                            .title("Co-writer"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
        }
    });
}

/// Older manifests contain just a repeated release title. Do not give those
/// (or empty bodies) a large, empty-looking notes region.
fn release_notes<'a>(version: &str, notes: Option<&'a str>) -> Option<&'a str> {
    let notes = notes?.trim();
    let version = version.trim_start_matches('v');
    if notes.is_empty()
        || notes == format!("Co-writer v{version}")
        || notes == format!("Co-writer {version}")
    {
        None
    } else {
        Some(notes)
    }
}

fn show_prompt(
    app: &AppHandle,
    version: String,
    notes: Option<String>,
    respond: impl FnOnce(Result<bool, String>) + Send + 'static,
) -> Result<(), String> {
    let notes = release_notes(&version, notes.as_deref()).map(str::to_owned);
    let parent = dialog_parent(app).ok_or("No visible window for the update sheet")?;
    #[cfg(target_os = "macos")]
    {
        native::show(app, parent, version, notes, respond).map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut body = format!("Version {version} is available.");
        if let Some(notes) = notes {
            body.push_str(&format!("\n\n{notes}"));
        }
        with_parent(
            app.dialog()
                .message(body)
                .kind(MessageDialogKind::Info)
                .title("What’s new in Co-writer")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Install and Restart".to_string(),
                    "Later".to_string(),
                )),
            Some(&parent),
        )
        .show(move |accepted| respond(Ok(accepted)));
        Ok(())
    }
}

fn prompt_install(app: AppHandle, version: String, notes: Option<String>) {
    let response_app = app.clone();
    let response_version = version.clone();
    let result = show_prompt(&app, version.clone(), notes, move |result| {
        match result {
            Ok(true) => start_install(response_app, &response_version),
            Ok(false) => {
                let mgr = manager(&response_app);
                mgr.update_session(|session| {
                    if session.dismiss(&response_version) {
                        // Persist before admitting the next automatic check.
                        mgr.write_dismissed_version(Some(&response_version));
                    }
                });
            }
            Err(message) => fail_prompt(&response_app, &response_version, message),
        }
    });
    if let Err(message) = result {
        fail_prompt(&app, &version, message);
    }
}

fn fail_prompt(app: &AppHandle, version: &str, message: String) {
    let mgr = manager(app);
    let failed = mgr.update_session(|session| {
        if !session.matches_version(version) {
            return false;
        }
        session.pending = None;
        session.state = UpdaterState::Error {
            message: message.clone(),
        };
        true
    });
    if failed {
        eprintln!("Could not show update sheet: {message}");
        with_parent(
            app.dialog()
                .message(format!("Could not show update.\n\n{message}"))
                .kind(MessageDialogKind::Error)
                .title("Co-writer"),
            dialog_parent(app).as_ref(),
        )
        .show(|_| {});
    }
}

/// Download + install the pending update, then relaunch the app.
fn start_install(app: AppHandle, version: &str) {
    let pending = manager(&app).update_session(|session| session.take_for_install(version));

    let Some(update) = pending else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        let version = update.version.clone();
        let result = update
            .download_and_install(|_chunk, _total| {}, || {})
            .await;

        match result {
            Ok(_) => {
                manager(&app).set_state(UpdaterState::ReadyToInstall {
                    version: version.clone(),
                });
                // Clear any previously dismissed version once an install completes.
                manager(&app).write_dismissed_version(None);
                app.restart();
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                let parent = dialog_parent(&app);
                with_parent(
                    app.dialog()
                        .message(format!("Update failed.\n\n{}", message))
                        .kind(MessageDialogKind::Error)
                        .title("Co-writer"),
                    parent.as_ref(),
                )
                .show(|_| {});
            }
        }
    });
}

/// Spawn the background task that runs a check once per day while the app is
/// open. The initial at-launch check is triggered separately from `setup`.
pub fn spawn_daily_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DAILY_CHECK_INTERVAL);
        // The first tick fires immediately — skip it because `setup` already
        // schedules the launch check.
        interval.tick().await;
        loop {
            interval.tick().await;
            start_check(app.clone(), false);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> UpdateSession<u32> {
        UpdateSession {
            state: UpdaterState::Available {
                version: "0.8.4".to_owned(),
            },
            pending: Some(42),
            #[cfg(debug_assertions)]
            preview_active: false,
        }
    }

    #[test]
    fn an_open_prompt_blocks_checks_and_consumes_only_its_update_once() {
        let mut session = available();
        assert!(!session.begin_check());
        assert_eq!(session.take_for_install("0.8.3"), None);
        assert_eq!(session.pending, Some(42));
        assert_eq!(session.take_for_install("0.8.4"), Some(42));
        assert!(matches!(session.state, UpdaterState::Downloading));
        assert_eq!(session.take_for_install("0.8.4"), None);
        assert!(!session.dismiss("0.8.4"));
        assert!(!session.begin_check());
    }

    #[test]
    fn dismissal_clears_only_the_displayed_update_and_allows_a_manual_recheck() {
        let mut session = available();
        assert!(!session.dismiss("0.8.3"));
        assert_eq!(session.pending, Some(42));
        assert!(session.dismiss("0.8.4"));
        assert_eq!(session.pending, None);
        assert!(session.begin_check());
        assert!(!session.begin_check());
        assert!(matches!(session.state, UpdaterState::Checking));
    }

    #[test]
    fn concurrent_install_callbacks_consume_once_and_a_late_response_cannot_dismiss_the_next_update(
    ) {
        use std::sync::Barrier;
        use std::thread;

        let session = Arc::new(Mutex::new(available()));
        let barrier = Arc::new(Barrier::new(3));
        let callbacks: Vec<_> = (0..2)
            .map(|_| {
                let session = session.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    session.lock().take_for_install("0.8.4")
                })
            })
            .collect();
        barrier.wait();
        let installed: Vec<_> = callbacks
            .into_iter()
            .filter_map(|callback| callback.join().unwrap())
            .collect();
        assert_eq!(installed, vec![42]);
        let mut session = session.lock();
        session.state = UpdaterState::Available {
            version: "0.8.5".to_owned(),
        };
        session.pending = Some(43);
        assert!(!session.dismiss("0.8.4"));
        assert_eq!(session.take_for_install("0.8.4"), None);
        assert_eq!(session.take_for_install("0.8.5"), Some(43));
    }

    #[test]
    fn legacy_titles_and_empty_notes_have_no_notes_region() {
        for notes in [
            None,
            Some(" \n"),
            Some("Co-writer v0.8.3"),
            Some("Co-writer 0.8.3\n"),
        ] {
            assert_eq!(release_notes("0.8.3", notes), None);
        }
        let notes = "- Copy tables with ⌘C.\n\n- Use `/compact`.";
        assert_eq!(release_notes("0.8.3", Some(notes)), Some(notes));
        assert_eq!(
            release_notes("0.8.4", Some("Co-writer v0.8.3")),
            Some("Co-writer v0.8.3")
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn preview_blocks_operations_without_consuming_or_changing_the_session() {
        let mut session = UpdateSession::<u32>::new();
        session.state = UpdaterState::UpToDate;
        assert!(session.begin_preview());
        assert!(!session.begin_preview());
        assert!(!session.begin_check());
        assert!(!session.dismiss("0.8.3"));
        assert_eq!(session.take_for_install("0.8.3"), None);
        session.end_preview();
        assert!(matches!(session.state, UpdaterState::UpToDate));
        assert_eq!(session.pending, None);
        assert!(session.begin_check());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn preview_cannot_start_over_a_real_prompt_or_download() {
        let mut session = available();
        assert!(!session.begin_preview());
        assert_eq!(session.take_for_install("0.8.4"), Some(42));
        assert!(!session.begin_preview());
    }
}
