package app.tasksng.android.ui

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import app.tasksng.android.Graph
import app.tasksng.android.data.SecretStore
import app.tasksng.android.data.WebLink
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun AppRoot(vm: TasksViewModel) {
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    TasksTheme(prefs.theme, prefs.dynamicColor) {
        val ready by vm.ready.collectAsStateWithLifecycle()
        val snapshot by vm.snapshot.collectAsStateWithLifecycle()
        val screen by vm.screen.collectAsStateWithLifecycle()
        val detailId by vm.detailId.collectAsStateWithLifecycle()
        val quickAdd by vm.quickAdd.collectAsStateWithLifecycle()
        val snackbar = remember { SnackbarHostState() }
        val signedIn = snapshot.account != null

        LaunchedEffect(Unit) {
            vm.messages.collect { m ->
                launch {
                    val result = snackbar.showSnackbar(
                        m.text, m.actionLabel, withDismissAction = m.actionLabel == null && m.long,
                        duration = if (m.long || m.actionLabel != null) SnackbarDuration.Long else SnackbarDuration.Short,
                    )
                    if (result == SnackbarResult.ActionPerformed) m.action?.invoke()
                }
            }
        }
        if (ready && signedIn) {
            KeepInSync(vm, prefs.syncInterval)
            LinkedBrowsers(vm)
        }

        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize()) {
                when {
                    !ready -> {}
                    !signedIn && screen !is Screen.Pairing -> SetupScreen(vm)
                    signedIn -> MainScreen(vm)
                }
                val slideIn = slideInHorizontally { it / 4 } + fadeIn()
                val slideOut = slideOutHorizontally { it / 4 } + fadeOut()
                AnimatedVisibility(ready && signedIn && detailId != null && screen == Screen.Main, enter = slideIn, exit = slideOut) {
                    val id = remember { mutableStateHolder(detailId) }
                    if (detailId != null) id.value = detailId
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        id.value?.let { TaskDetailScreen(vm, it) { vm.detailId.value = null } }
                    }
                }
                AnimatedVisibility(ready && screen == Screen.Settings, enter = slideIn, exit = slideOut) {
                    Surface(Modifier.fillMaxSize()) { SettingsScreen(vm) { vm.screen.value = Screen.Main } }
                }
                AnimatedVisibility(ready && screen == Screen.Conflicts, enter = slideIn, exit = slideOut) {
                    Surface(Modifier.fillMaxSize()) { ConflictsScreen(vm) { vm.screen.value = Screen.Main } }
                }
                AnimatedVisibility(ready && screen is Screen.Pairing, enter = slideIn, exit = slideOut) {
                    Surface(Modifier.fillMaxSize()) { PairingScreen(vm, (screen as? Screen.Pairing)?.code) { vm.screen.value = Screen.Main } }
                }
                if (ready && signedIn) quickAdd?.let { request -> QuickAddSheet(vm, request) { vm.quickAdd.value = null } }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 72.dp))
            }
        }
    }
}

private class Holder<T>(var value: T)

private fun <T> mutableStateHolder(initial: T) = Holder(initial)

/** Syncs when the app comes to the front, on the chosen interval while it is open, and when the network comes back. */
@Composable
private fun KeepInSync(vm: TasksViewModel, minutes: Int) {
    val context = LocalContext.current
    LifecycleResumeEffect(Unit) {
        vm.sync()
        onPauseOrDispose { Graph.scope.launch { runCatching { Graph.engine.flush() } } }
    }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(minutes, owner) {
        if (minutes <= 0) return@LaunchedEffect
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (isActive) {
                delay(minutes * 60_000L)
                vm.sync()
            }
        }
    }
    DisposableEffect(Unit) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        var first = true
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // The first call only reports the network that is there already.
                if (first) first = false else vm.sync()
            }
        }
        runCatching { manager?.registerDefaultNetworkCallback(callback) }
        onDispose { runCatching { manager?.unregisterNetworkCallback(callback) } }
    }
}

/** While the app is open, listens to each paired web app: a change made in a browser syncs here at once. */
@Composable
private fun LinkedBrowsers(vm: TasksViewModel) {
    val prefs by vm.prefs.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    for (server in prefs.linked) {
        LaunchedEffect(server.deviceId, owner) {
            owner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                val token = Graph.secrets.get(SecretStore.deviceToken(server.deviceId)) ?: return@repeatOnLifecycle
                var wait = 2_000L
                while (isActive) {
                    val status = withContext(Dispatchers.IO) {
                        runCatching {
                            WebLink.listen(server.baseUrl, token, onOpen = { wait = 2_000L }) { event ->
                                when (event) {
                                    "changed" -> vm.sync()
                                    "unlinked" -> vm.forgetLink(server)
                                }
                            }
                        }.getOrDefault(0)
                    }
                    if (status == 401 || status == 403) {
                        // The web app no longer knows this phone.
                        vm.forgetLink(server)
                        return@repeatOnLifecycle
                    }
                    delay(wait)
                    wait = (wait * 2).coerceAtMost(60_000L)
                }
            }
        }
    }
}
