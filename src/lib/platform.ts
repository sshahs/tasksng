/** The operating system the UI runs on, for wording (WebView2 vs WebKitGTK). */
export const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
export const isLinux = !isWindows && typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);

/** What the Super key is called on this system. */
export const superKey = isWindows ? "Win" : "Super";
