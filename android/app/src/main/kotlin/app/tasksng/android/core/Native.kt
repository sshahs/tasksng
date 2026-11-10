package app.tasksng.android.core

/** The sync engine (Rust, `crates/tasks-android`). Everything crosses as JSON text. */
object Native {
    init {
        System.loadLibrary("tasksng_engine")
    }

    /** Opens the task cache in [dataDir]. Answers `{"ok": null}` or `{"error": …}`. */
    @JvmStatic
    external fun init(dataDir: String, password: String?): String

    /** Runs a command; blocks until it is done. Answers `{"ok": …}` or `{"error": …}`. */
    @JvmStatic
    external fun invoke(cmd: String, args: String): String

    /** Waits for a background event: `{"name": …, "data": …}`, or null after [timeoutMs]. */
    @JvmStatic
    external fun nextEvent(timeoutMs: Long): String?
}
