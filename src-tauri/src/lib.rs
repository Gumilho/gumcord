use tauri::utils::config::FrontendDist;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::WebviewWindowBuilder;

// The desktop app is a window onto the Gumcord site (build.frontendDist). The site does all the
// work, so app updates ship with the server and friends never need to reinstall.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Give calls what a browser tab gets once allowed; the OS still asks where it requires.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture => {
                PermissionResponse::Allow
            }
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            let config = app.config();
            // Only Gumcord's own pages load in the window; any other link opens in the browser.
            let own_origins: Vec<_> = [
                config.build.dev_url.clone(),
                match &config.build.frontend_dist {
                    Some(FrontendDist::Url(url)) => Some(url.clone()),
                    _ => None,
                },
            ]
            .into_iter()
            .flatten()
            .map(|url| url.origin())
            .collect();

            let main = config
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .expect("tauri.conf.json defines the main window");
            let window = WebviewWindowBuilder::from_config(app.handle(), main)?
                // Tells the site it's in the app: passkeys don't work in webviews, so it signs in through the browser.
                .initialization_script("window.gumcordDesktop = true;")
                .on_navigation(move |url| {
                    let own = url.scheme() == "about" || own_origins.contains(&url.origin());
                    if !own {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    own
                })
                // window.open and target="_blank" links (sign-in, attachments) go to the browser.
                .on_new_window(|url, _| {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;

            #[cfg(target_os = "linux")]
            enable_webrtc(&window)?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// WebKitGTK ships with microphone access and WebRTC switched off.
#[cfg(target_os = "linux")]
fn enable_webrtc(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let url = window.url()?;
    window.with_webview(move |webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
        }
        // The first page may have started loading before these settings applied; load it again with them.
        view.load_uri(url.as_str());
    })
}
