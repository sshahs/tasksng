const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

/** The operating system the UI runs on, for wording (WebView2 vs WebKitGTK). */
export const isWindows = /windows/i.test(ua);
export const isAndroid = /android/i.test(ua);
/** Desktop Linux (Android's user agent says Linux too). */
export const isLinux = !isWindows && !isAndroid && /linux/i.test(ua);

/** What the Super key is called on this system. */
export const superKey = isWindows ? "Win" : "Super";

/** What the Android app's activity offers the page (MainActivity.kt). */
export interface AndroidBridge {
  /** JSON of the reminder button that started the app, once. */
  takeLaunchAction(): string | null;
  /** Colours the status and navigation bars like the page. */
  setDarkTheme(dark: boolean): void;
  /** Sends the app to the background, like Back on the home screen. */
  moveToBack(): void;
}

export function androidBridge(): AndroidBridge | undefined {
  return (window as { TasksNGAndroid?: AndroidBridge }).TasksNGAndroid;
}
