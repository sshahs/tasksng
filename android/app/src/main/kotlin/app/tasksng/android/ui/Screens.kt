package app.tasksng.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Vibration
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.tasksng.android.BuildConfig
import app.tasksng.android.MainActivity
import app.tasksng.android.R
import app.tasksng.android.core.ConflictView
import app.tasksng.android.data.PairingCode
import app.tasksng.android.data.ThemeMode
import app.tasksng.android.data.WebLink
import app.tasksng.android.logic.DEFAULT_REMINDERS
import app.tasksng.android.logic.defaultPicks
import app.tasksng.android.logic.differingFields
import app.tasksng.android.logic.relativeTime
import app.tasksng.android.logic.resolutionFor
import app.tasksng.android.logic.versionTime
import app.tasksng.android.work.Reminders
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Page(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = { TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { padding -> Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState())) { content() } }
}

// ---------------------------------------------------------------------------
// Sign in

@Composable
fun SetupScreen(vm: TasksViewModel) {
    val connecting by vm.connecting.collectAsStateWithLifecycle()
    var server by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var advanced by remember { mutableStateOf(false) }
    var insecure by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun submit() {
        error = null
        vm.connect(server, username, password, insecure) { error = it }
    }
    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Column(Modifier.widthIn(max = 420.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(painterResource(R.drawable.ic_stat_tasksng), null, Modifier.size(56.dp), tint = MaterialTheme.colorScheme.primary)
            Text("TasksNG", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "Sign in to your Baikal (or other CalDAV) server. Your tasks stay there; this phone keeps a copy to work offline.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                server, { server = it }, Modifier.fillMaxWidth(), label = { Text("Server address") }, placeholder = { Text("dav.example.com") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            )
            OutlinedTextField(
                username, { username = it }, Modifier.fillMaxWidth(), label = { Text("Username") }, singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            )
            OutlinedTextField(
                password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true,
                visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                trailingIcon = {
                    IconButton(onClick = { showPassword = !showPassword }) {
                        Icon(if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility, if (showPassword) "Hide password" else "Show password")
                    }
                },
            )
            if (advanced) Row(Modifier.fillMaxWidth().clickable { insecure = !insecure }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(insecure, { insecure = it })
                Column {
                    Text("Accept invalid TLS certificates")
                    Text("For a self-signed certificate on your own server", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else TextButton(onClick = { advanced = true }, modifier = Modifier.align(Alignment.Start)) { Text("Advanced") }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(onClick = ::submit, enabled = !connecting && server.isNotBlank() && username.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                if (connecting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary) else Text("Sign in")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f))
                Text("  or  ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(Modifier.weight(1f))
            }
            OutlinedButton(onClick = { vm.screen.value = Screen.Pairing() }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.QrCodeScanner, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Pair with the TasksNG web app")
            }
            Text(
                "Already signed in to TasksNG in a browser? Open Settings → Pair a phone there and scan the code: no typing needed.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing with the web app

@Composable
fun PairingScreen(vm: TasksViewModel, initial: PairingCode?, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    var code by remember(initial) { mutableStateOf(initial) }
    var address by remember { mutableStateOf("") }
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@rememberLauncherForActivityResult
        val parsed = WebLink.parse(text)
        if (parsed == null) error = "That isn't a TasksNG pairing code. Open Settings → Pair a phone in the web app and scan the code shown there."
        else {
            error = null
            code = parsed
        }
    }
    fun scan() = scanner.launch(
        ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code shown in the TasksNG web app").setBeepEnabled(false).setOrientationLocked(false),
    )

    Page("Pair with the web app", onClose) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (done != null) {
                EmptyState(Icons.Outlined.TaskAlt, "Paired", done) { Button(onClick = onClose) { Text("Done") } }
                return@Column
            }
            Text(
                "Pairing links this phone with your self-hosted TasksNG web app. Signing in takes one scan, a browser can be signed in from here, and changes made on one show up on the other within seconds.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("1. In the web app, open Settings → Pair a phone (or the sign-in page).", style = MaterialTheme.typography.bodyMedium)
                    Text("2. Scan the code it shows.", style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = ::scan, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.QrCodeScanner, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Scan the code")
                    }
                }
            }
            Text("Or type it in", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                address, { address = it }, Modifier.fillMaxWidth(), label = { Text("Web app address") }, placeholder = { Text("tasks.example.com") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            )
            OutlinedTextField(
                typed, { typed = it.uppercase() }, Modifier.fillMaxWidth(), label = { Text("Pairing code") }, placeholder = { Text("ABCD-EFGH") }, singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done, autoCorrectEnabled = false),
            )
            OutlinedButton(
                enabled = address.isNotBlank() && typed.isNotBlank(),
                onClick = {
                    val base = WebLink.normalizeBase(address)
                    val c = WebLink.normalizeCode(typed)
                    if (base == null) error = "Enter the web app's address, like tasks.example.com"
                    else if (c == null) error = "The code is eight letters and digits, like ABCD-EFGH"
                    else {
                        error = null
                        code = PairingCode(base, c, "pair")
                    }
                },
            ) { Text("Pair") }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        }
    }

    code?.let { c ->
        val login = c.mode == "login"
        val knows = vm.prefs.collectAsStateWithLifecycle().value.linked.any { it.baseUrl == c.baseUrl }
        AlertDialog(
            onDismissRequest = { if (!busy) code = null },
            icon = { if (!c.secure) Icon(Icons.Default.Warning, null, tint = LocalTaskColors.current.medium) else Icon(Icons.Default.Computer, null) },
            title = { Text(if (login) "Sign in the browser?" else "Pair with ${c.host}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        when {
                            login && knows -> "The browser showing this code at ${c.host} will be signed in to your tasks (${snapshot.account?.username})."
                            login -> "The browser showing this code at ${c.host} will be signed in to your tasks. This phone sends its server address, username and password to ${c.host} for that."
                            snapshot.account == null -> "This phone signs in with the account the web app at ${c.host} uses, and the two stay linked."
                            else -> "This phone and the web app at ${c.host} will be linked."
                        },
                    )
                    Text("Only continue if you are looking at this code on your own screen.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!c.secure) Text(
                        "This web app doesn't use HTTPS: on anything but your home network, others could read what is sent.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        val problem = vm.usePairingCode(c)
                        busy = false
                        code = null
                        if (problem != null) error = problem
                        else done = if (login) "The browser at ${c.host} is signed in." else "This phone and ${c.host} are linked. Changes on one now show up on the other right away."
                    }
                }) { if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text(if (login) "Sign in" else "Pair") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { code = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------------------
// Tasks changed on two devices

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConflictCard(vm: TasksViewModel, c: ConflictView) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val mine = c.mine
    val theirs = c.theirs
    val picks = remember(c.id) { mutableStateMapOf<String, Boolean>().apply { putAll(defaultPicks(c)) } }
    Card(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text((mine ?: theirs)?.summary?.ifEmpty { "Untitled task" } ?: "Task", style = MaterialTheme.typography.titleMedium)
            Text("Changed ${versionTime(c.at)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (mine == null || theirs == null) {
                Text(
                    if (mine == null) "You deleted this task here, and it was changed on another device." else "You changed this task here, and another device deleted it.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.resolveConflict(c, resolutionFor(c, emptyMap(), keepMineWhole = mine != null)) }) { Text(if (mine == null) "Keep it" else "Keep my version") }
                    OutlinedButton(onClick = { vm.resolveConflict(c, resolutionFor(c, emptyMap(), keepMineWhole = mine == null)) }) { Text("Delete it") }
                }
            } else {
                for (f in differingFields(mine, theirs)) {
                    Text(f.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = picks[f.key] == true, onClick = { picks[f.key] = true }, label = { Text("This phone: " + f.show(mine, snapshot.tasks).take(80)) })
                        FilterChip(selected = picks[f.key] != true, onClick = { picks[f.key] = false }, label = { Text("Other device: " + f.show(theirs, snapshot.tasks).take(80)) })
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.resolveConflict(c, resolutionFor(c, picks.toMap())) }) { Text("Keep the selection") }
                    TextButton(onClick = { vm.resolveConflict(c, resolutionFor(c, differingFields(mine, theirs).associate { it.key to true })) }) { Text("All from this phone") }
                    TextButton(onClick = { vm.resolveConflict(c, resolutionFor(c, emptyMap())) }) { Text("All from the other") }
                }
            }
        }
    }
}

@Composable
fun ConflictsScreen(vm: TasksViewModel, onClose: () -> Unit) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    Page("Changed on two devices", onClose) {
        Text(
            "These tasks were changed here and on another device before they synced. Both versions are kept until you choose.",
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        for (c in snapshot.conflicts) ConflictCard(vm, c)
    }
}

// ---------------------------------------------------------------------------
// Settings

@Composable
private fun <T> ChoiceRow(title: String, options: List<Pair<String, T>>, current: T, onPick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    SettingRow(null, title, options.firstOrNull { it.second == current }?.first, Modifier.clickable { open = true }.padding(start = 38.dp))
    if (open) Sheet(title, { open = false }) {
        for ((label, value) in options) SheetItem(null, label, selected = value == current) {
            onPick(value)
            open = false
        }
    }
}

@Composable
fun SettingsScreen(vm: TasksViewModel, onClose: () -> Unit) {
    val context = LocalContext.current
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val status by vm.status.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    var signOut by remember { mutableStateOf(false) }
    var canNotify by remember { mutableStateOf(Reminders.canNotify(context)) }
    LifecycleResumeEffect(Unit) {
        canNotify = Reminders.canNotify(context)
        onPauseOrDispose {}
    }
    val lists = remember(snapshot.lists) { TasksViewModel.sortedLists(snapshot.lists).filter { !it.readOnly } }

    Page("Settings", onClose) {
        SectionLabel("Account")
        SettingRow(Icons.Default.Sync, snapshot.account?.username ?: "Not signed in", snapshot.account?.serverUrl)
        SettingRow(
            null,
            when (status.state) {
                "syncing" -> "Syncing…"
                "offline" -> "Offline"
                "error" -> "Sync problem"
                "auth-required" -> "Sign in again to sync"
                else -> "Synced ${relativeTime(status.lastSync)}"
            },
            status.message ?: if (status.pending > 0) "${status.pending} changes waiting to be sent" else "Everything is saved on the server",
            Modifier.padding(start = 38.dp),
        ) { TextButton(onClick = { vm.sync(manual = true) }) { Text("Sync now") } }
        ChoiceRow("Sync while the app is open", listOf("Every minute" to 1, "Every 5 minutes" to 5, "Every 15 minutes" to 15, "Every 30 minutes" to 30, "Only by hand" to 0), prefs.syncInterval) { v -> vm.updatePrefs { it.copy(syncInterval = v) } }
        ChoiceRow(
            "Sync in the background",
            listOf("Every 15 minutes" to 15, "Every 30 minutes" to 30, "Every hour" to 60, "Every 3 hours" to 180, "Never" to 0), prefs.backgroundSync,
        ) { v -> vm.updatePrefs { it.copy(backgroundSync = v) } }
        if (lists.isNotEmpty()) ChoiceRow("New tasks go to", lists.map { it.name to it.id }, prefs.defaultList ?: lists.first().id) { v -> vm.updatePrefs { it.copy(defaultList = v) } }
        SettingRow(Icons.AutoMirrored.Filled.Logout, "Sign out", "Removes the tasks and the password from this phone", Modifier.clickable { signOut = true })
        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        SectionLabel("Web app")
        for (server in prefs.linked) SettingRow(Icons.Default.Computer, server.baseUrl.substringAfter("://"), "Paired ${relativeTime(server.pairedAt)}") {
            TextButton(onClick = { vm.unlink(server) }) { Text("Unpair") }
        }
        SettingRow(
            Icons.Default.QrCodeScanner, if (prefs.linked.isEmpty()) "Pair with the web app" else "Pair another, or sign in a browser",
            "Scan the code the TasksNG web app shows", Modifier.clickable { vm.screen.value = Screen.Pairing() },
        )
        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        SectionLabel("Reminders")
        SettingRow(Icons.Default.Notifications, "Show reminders", "As notifications with Snooze and Done, also while TasksNG is closed") {
            Switch(settings.reminders, { vm.setReminders(it) })
        }
        ChoiceRow("For tasks with a due time", DEFAULT_REMINDERS, settings.defaultReminder) { vm.setDefaultReminder(it) }
        if (!canNotify) SettingRow(
            Icons.Default.Warning, "Notifications are turned off", "Tap to allow them for TasksNG",
            Modifier.clickable {
                val activity = context as? MainActivity
                if (Build.VERSION.SDK_INT >= 33 && activity != null && activity.shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS).not() &&
                    activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
                ) activity.askForNotifications()
                else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            },
        )
        SettingRow(Icons.Default.NotificationsActive, "Send a test notification", null, Modifier.clickable { Reminders.showTest(context) })
        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        SectionLabel("Appearance")
        ChoiceRow("Theme", ThemeMode.entries.map { it.label to it }, prefs.theme) { v -> vm.updatePrefs { it.copy(theme = v) } }
        if (Build.VERSION.SDK_INT >= 31) SettingRow(Icons.Default.Palette, "Colours from the wallpaper", "Material You") {
            Switch(prefs.dynamicColor, { v -> vm.updatePrefs { it.copy(dynamicColor = v) } })
        }
        SettingRow(Icons.Default.Vibration, "Vibrate when completing a task", null) { Switch(prefs.haptics, { v -> vm.updatePrefs { it.copy(haptics = v) } }) }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        SectionLabel("About")
        SettingRow(Icons.Default.Info, "TasksNG ${BuildConfig.VERSION_NAME}", "Tasks are standard iCalendar to-dos on your own server")
        SettingRow(
            Icons.Default.DarkMode.takeIf { false }, "Add the Today widget", "Long-press the home screen → Widgets → TasksNG",
            Modifier.padding(start = 38.dp),
        )
        Spacer(Modifier.height(32.dp))
    }
    if (signOut) ConfirmDialog(
        "Sign out?", "The tasks stay on your server. Changes that haven't synced yet (${status.pending}) are lost.", "Sign out",
        destructive = true, onDismiss = { signOut = false },
    ) { vm.signOut() }
}
