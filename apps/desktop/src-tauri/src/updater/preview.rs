//! This entire module, including its fixture, is absent from release builds.

use super::{manager, show_prompt, UpdateSession};
use tauri::AppHandle;

const NOTES: &str = include_str!("../../tests/fixtures/update-v0.8.3.txt");

pub(crate) enum PreviewKind {
    Standard,
    Long,
    WithoutNotes,
}

pub(crate) fn start_preview(app: AppHandle, kind: PreviewKind) {
    if !manager(&app).update_session(UpdateSession::begin_preview) {
        eprintln!("Update preview unavailable while another update operation is active");
        return;
    }
    let notes = match kind {
        PreviewKind::Standard => Some(NOTES.to_owned()),
        PreviewKind::Long => Some(format!(
            "{}\n\n- End of long preview. All release notes are reachable.",
            NOTES.repeat(5)
        )),
        PreviewKind::WithoutNotes => None,
    };
    let response_app = app.clone();
    // This callback deliberately ignores the button choice. Neither button can
    // reach start_install or persisted dismissal, even if a real update exists.
    let result = show_prompt(&app, "0.8.3".to_owned(), notes, move |result| {
        manager(&response_app).update_session(UpdateSession::end_preview);
        if let Err(error) = result {
            eprintln!("Could not show update preview: {error}");
        }
    });
    if let Err(error) = result {
        manager(&app).update_session(UpdateSession::end_preview);
        eprintln!("Could not show update preview: {error}");
    }
}
