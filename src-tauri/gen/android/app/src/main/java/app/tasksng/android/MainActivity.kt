package app.tasksng.android

import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  /**
   * The reminder button (or the reminder itself) that started the app. The
   * notification plugin reports it before the page can listen, so the page
   * asks for it once it has loaded (`TasksNGAndroid.takeLaunchAction()`).
   */
  @Volatile private var launchAction: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    if (savedInstanceState == null) {
      launchAction = notificationAction(intent)
    }
    super.onCreate(savedInstanceState)

    // Edge to edge: keep the page clear of the status bar, the navigation
    // bar, display cutouts and the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    applyTheme(systemIsDark())
    askForLocalNetwork()
  }

  /**
   * From Android 17, connections to the home network (a Baikal server on a PC
   * or NAS) time out unless the user allows "Nearby devices". Asked at each
   * start until allowed; Android stops showing the prompt after two refusals.
   */
  private fun askForLocalNetwork() {
    if (Build.VERSION.SDK_INT < 37) return
    if (checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED) return
    requestPermissions(arrayOf(LOCAL_NETWORK), LOCAL_NETWORK_REQUEST)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(Bridge(), "TasksNGAndroid")
  }

  private fun systemIsDark(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  /** Colours the system bars like the page (the theme set in TasksNG may differ from Android's). */
  private fun applyTheme(dark: Boolean) {
    val background = if (dark) Color.rgb(0x0d, 0x0e, 0x10) else Color.WHITE
    window.decorView.setBackgroundColor(background)
    findViewById<View>(android.R.id.content)?.setBackgroundColor(background)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  private fun notificationAction(intent: Intent?): String? {
    if (intent == null || !intent.hasExtra("NotificationId")) return null
    // Opened again from the recent apps: the button was handled already.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    val action = JSONObject()
    action.put("actionId", intent.getStringExtra("NotificationUserAction") ?: "tap")
    intent.getStringExtra("LocalNotficationObject")?.let { json ->
      runCatching { action.put("notification", JSONObject(json)) }
    }
    return action.toString()
  }

  private companion object {
    const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    const val LOCAL_NETWORK_REQUEST = 37
  }

  inner class Bridge {
    @JavascriptInterface
    fun takeLaunchAction(): String? {
      val action = launchAction
      launchAction = null
      return action
    }

    @JavascriptInterface
    fun setDarkTheme(dark: Boolean) {
      runOnUiThread { applyTheme(dark) }
    }

    @JavascriptInterface
    fun moveToBack() {
      runOnUiThread { moveTaskToBack(true) }
    }
  }
}
