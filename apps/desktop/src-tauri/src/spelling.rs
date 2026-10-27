//! macOS spell checking for the editor's WKWebView.
//!
//! WebKit reads its spelling switches from the app's user defaults and treats a
//! missing `WebContinuousSpellCheckingEnabled` as off. Native apps expose those
//! switches through Edit › Spelling and Grammar, whose items are plain AppKit
//! actions sent to the first responder; Tauri's menu API has no such items, so
//! they are added to the Edit submenu directly.

use crate::macos::ns_string;
use objc2::runtime::{AnyObject, Sel};
use objc2::{class, msg_send, sel};

/// Registers spelling defaults before any webview reads them. Registered
/// defaults sit below the user's own choices, so toggling an item in the menu
/// still persists across launches.
pub(crate) fn register_defaults() {
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
        set_bool(defaults, "WebContinuousSpellCheckingEnabled", true);
        // Off by default: autocorrect would rewrite markdown syntax and code.
        set_bool(defaults, "WebAutomaticSpellingCorrectionEnabled", false);
        let user_defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let _: () = msg_send![user_defaults, registerDefaults: defaults];
    }
}

unsafe fn set_bool(dict: *mut AnyObject, key: &str, value: bool) {
    unsafe {
        let number: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: value];
        let _: () = msg_send![dict, setObject: number, forKey: ns_string(key)];
    }
}

/// Appends the standard Spelling and Grammar submenu to the app menu's Edit
/// submenu. Must run on the main thread after the app menu is installed.
pub(crate) fn install_menu(edit_title: &str) {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let main_menu: *mut AnyObject = msg_send![app, mainMenu];
        if main_menu.is_null() {
            eprintln!("failed to install Spelling menu: main menu unavailable");
            return;
        }
        let edit_item: *mut AnyObject = msg_send![main_menu, itemWithTitle: ns_string(edit_title)];
        let edit_menu: *mut AnyObject = if edit_item.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![edit_item, submenu]
        };
        if edit_menu.is_null() {
            eprintln!("failed to install Spelling menu: Edit submenu not found");
            return;
        }

        let title = ns_string("Spelling and Grammar");
        let spelling_menu: *mut AnyObject = msg_send![class!(NSMenu), alloc];
        let spelling_menu: *mut AnyObject = msg_send![spelling_menu, initWithTitle: title];
        add_item(
            spelling_menu,
            "Show Spelling and Grammar",
            sel!(showGuessPanel:),
            ":",
        );
        add_item(
            spelling_menu,
            "Check Document Now",
            sel!(checkSpelling:),
            ";",
        );
        add_separator(spelling_menu);
        add_item(
            spelling_menu,
            "Check Spelling While Typing",
            sel!(toggleContinuousSpellChecking:),
            "",
        );
        add_item(
            spelling_menu,
            "Check Grammar With Spelling",
            sel!(toggleGrammarChecking:),
            "",
        );
        add_item(
            spelling_menu,
            "Correct Spelling Automatically",
            sel!(toggleAutomaticSpellingCorrection:),
            "",
        );

        let parent: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
        let parent: *mut AnyObject = msg_send![
            parent,
            initWithTitle: title,
            action: Option::<Sel>::None,
            keyEquivalent: ns_string("")
        ];
        let _: () = msg_send![parent, setSubmenu: spelling_menu];
        add_separator(edit_menu);
        let _: () = msg_send![edit_menu, addItem: parent];
        let _: () = msg_send![parent, release];
        let _: () = msg_send![spelling_menu, release];
    }
}

/// A nil target sends the action up the responder chain, where the focused
/// WKWebView handles it and validates the item's checkmark.
unsafe fn add_item(menu: *mut AnyObject, title: &str, action: Sel, key: &str) {
    unsafe {
        let item: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
        let item: *mut AnyObject = msg_send![
            item,
            initWithTitle: ns_string(title),
            action: Some(action),
            keyEquivalent: ns_string(key)
        ];
        let _: () = msg_send![menu, addItem: item];
        let _: () = msg_send![item, release];
    }
}

unsafe fn add_separator(menu: *mut AnyObject) {
    unsafe {
        let separator: *mut AnyObject = msg_send![class!(NSMenuItem), separatorItem];
        let _: () = msg_send![menu, addItem: separator];
    }
}
