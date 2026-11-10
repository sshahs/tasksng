package app.tasksng.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import app.tasksng.android.data.WebLink
import app.tasksng.android.logic.Views
import app.tasksng.android.ui.AppRoot
import app.tasksng.android.ui.QuickAddRequest
import app.tasksng.android.ui.Screen
import app.tasksng.android.ui.TasksViewModel
import app.tasksng.android.ui.isDark
import app.tasksng.android.widget.TodayWidget
import app.tasksng.android.work.Reminders
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: TasksViewModel by viewModels()
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        // Reminders that were waiting for the permission can be scheduled now.
        lifecycleScope.launch { runCatching { Reminders.reschedule(applicationContext) } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        Graph.attach(this)
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            val prefs by vm.prefs.collectAsStateWithLifecycle()
            val dark = isDark(prefs.theme)
            // The system bars follow the theme chosen in TasksNG, which may differ from Android's.
            LaunchedEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            AppRoot(vm)
        }
        if (savedInstanceState == null) handle(intent)
        askForPermissions()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    /**
     * Notifications (Android 13 and later) once someone is signed in, and from
     * Android 17 "Nearby devices", without which connections to the home
     * network (a Baikal server on a PC or NAS) time out.
     */
    private fun askForPermissions() {
        lifecycleScope.launch {
            vm.ready.first { it }
            val wanted = mutableListOf<String>()
            if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) wanted += LOCAL_NETWORK
            if (Build.VERSION.SDK_INT >= 33 && vm.account != null &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            ) wanted += Manifest.permission.POST_NOTIFICATIONS
            if (wanted.isNotEmpty()) askPermissions.launch(wanted.toTypedArray())
        }
    }

    fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33) askPermissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
    }

    /** A tap on a reminder, the widget, an app shortcut, "Share", or the web app's pairing link. */
    private fun handle(intent: Intent?) {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val action = intent.action ?: return
        lifecycleScope.launch {
            vm.ready.first { it }
            when (action) {
                ACTION_OPEN_TASK, TodayWidget.ACTION_OPEN -> {
                    val id = intent.getStringExtra(TodayWidget.EXTRA_TASK)
                    val uid = intent.getStringExtra(Reminders.EXTRA_UID)
                    if (id != null && vm.task(id) != null) vm.openTask(id) else if (!uid.isNullOrEmpty()) vm.openTaskByUid(uid)
                }
                TodayWidget.ACTION_ADD -> if (vm.account != null) {
                    vm.screen.value = Screen.Main
                    vm.detailId.value = null
                    vm.quickAdd.value = QuickAddRequest()
                }
                TodayWidget.ACTION_TODAY -> show(Views.TODAY)
                ACTION_PLAN -> show(Views.PLAN)
                Intent.ACTION_SEND -> if (vm.account != null) {
                    val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
                    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty().trim()
                    // A shared page: its title becomes the task, the link goes into the notes.
                    val title = subject.ifEmpty { text.lineSequence().firstOrNull().orEmpty() }.take(200)
                    val notes = text.takeIf { it != title && it.isNotEmpty() }
                    vm.screen.value = Screen.Main
                    vm.detailId.value = null
                    vm.quickAdd.value = QuickAddRequest(title, notes)
                }
                Intent.ACTION_VIEW -> intent.dataString?.let(WebLink::parse)?.let { vm.screen.value = Screen.Pairing(it) }
            }
        }
    }

    private fun show(view: String) {
        if (vm.account == null) return
        vm.screen.value = Screen.Main
        vm.detailId.value = null
        vm.setView(view)
    }

    companion object {
        const val ACTION_OPEN_TASK = "app.tasksng.android.OPEN_TASK"
        const val ACTION_PLAN = "app.tasksng.android.PLAN"
        private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
