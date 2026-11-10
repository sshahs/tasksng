package app.tasksng.android.data

import android.content.Context
import android.content.SharedPreferences
import app.tasksng.android.logic.SavedSearch
import app.tasksng.android.logic.SortMode
import app.tasksng.android.logic.Views
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A TasksNG web app this phone is paired with. */
@Serializable
data class LinkedServer(
    /** The web app's address, without a trailing slash. */
    val baseUrl: String,
    val deviceId: String,
    /** What this phone is called there. */
    val deviceName: String,
    val pairedAt: String,
)

enum class ThemeMode(val id: String, val label: String) {
    System("system", "Follow the system"), Light("light", "Light"), Dark("dark", "Dark");

    companion object {
        fun of(id: String?) = entries.firstOrNull { it.id == id } ?: System
    }
}

data class UiPrefs(
    val theme: ThemeMode = ThemeMode.System,
    /** Colours from the wallpaper (Android 12 and later). */
    val dynamicColor: Boolean = true,
    /** Minutes between syncs while the app is open; 0 = only by hand. */
    val syncInterval: Int = 5,
    /** Minutes between syncs while the app is closed; 0 = never. */
    val backgroundSync: Int = 30,
    val view: String = Views.TODAY,
    val showCompleted: Boolean = false,
    val collapsed: Set<String> = emptySet(),
    val sorts: Map<String, String> = emptyMap(),
    val savedSearches: List<SavedSearch> = emptyList(),
    val defaultList: String? = null,
    val tagsOpen: Boolean = true,
    val linked: List<LinkedServer> = emptyList(),
    /** Completing a task plays a short vibration. */
    val haptics: Boolean = true,
    /** Notes open as rendered Markdown rather than as text to edit. */
    val notesPreview: Boolean = true,
) {
    fun sortFor(view: String): SortMode = SortMode.of(sorts[view])
}

/** View preferences, kept on this phone. */
class Prefs(context: Context) {
    private val store: SharedPreferences = context.getSharedPreferences("tasksng", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private val _state = MutableStateFlow(load())
    val state: StateFlow<UiPrefs> = _state
    val value: UiPrefs get() = _state.value

    private inline fun <reified T> decode(key: String, fallback: T): T =
        store.getString(key, null)?.let { runCatching { json.decodeFromString<T>(it) }.getOrNull() } ?: fallback

    private fun load() = UiPrefs(
        theme = ThemeMode.of(store.getString("theme", null)),
        dynamicColor = store.getBoolean("dynamic-color", true),
        syncInterval = store.getInt("sync-interval", 5),
        backgroundSync = store.getInt("background-sync", 30),
        view = store.getString("view", null) ?: Views.TODAY,
        showCompleted = store.getBoolean("show-completed", false),
        collapsed = store.getStringSet("collapsed", emptySet())!!.toSet(),
        sorts = decode("sorts", emptyMap()),
        savedSearches = decode("saved-searches", emptyList()),
        defaultList = store.getString("default-list", null),
        tagsOpen = store.getBoolean("tags-open", true),
        linked = decode("linked", emptyList()),
        haptics = store.getBoolean("haptics", true),
        notesPreview = store.getBoolean("notes-preview", true),
    )

    fun update(change: (UiPrefs) -> UiPrefs) {
        val before = _state.value
        val after = change(before)
        if (after == before) return
        _state.value = after
        store.edit().apply {
            putString("theme", after.theme.id)
            putBoolean("dynamic-color", after.dynamicColor)
            putInt("sync-interval", after.syncInterval)
            putInt("background-sync", after.backgroundSync)
            putString("view", after.view)
            putBoolean("show-completed", after.showCompleted)
            putStringSet("collapsed", after.collapsed)
            putString("sorts", json.encodeToString(after.sorts))
            putString("saved-searches", json.encodeToString(after.savedSearches))
            putString("default-list", after.defaultList)
            putBoolean("tags-open", after.tagsOpen)
            putString("linked", json.encodeToString(after.linked))
            putBoolean("haptics", after.haptics)
            putBoolean("notes-preview", after.notesPreview)
        }.apply()
    }
}
