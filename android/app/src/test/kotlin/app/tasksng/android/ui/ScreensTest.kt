package app.tasksng.android.ui

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.tasksng.android.Graph
import app.tasksng.android.core.TaskPatch
import app.tasksng.android.core.TaskStatus
import app.tasksng.android.data.ThemeMode
import app.tasksng.android.logic.Views
import app.tasksng.android.logic.iso
import app.tasksng.android.logic.parseQuickAdd
import com.github.takahirom.roborazzi.captureScreenRoboImage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.ZonedDateTime

/**
 * The app end to end on the JVM: the real engine (built for this computer),
 * signed in to a Baikal test server, with the screens drawn by Robolectric.
 *
 *   cargo build -p tasks-android
 *   (cd tools/baikal-dev-server && php -S 127.0.0.1:8800 router.php) &
 *   TASKSNG_TEST_URL=http://127.0.0.1:8800 ./gradlew :app:testDebugUnitTest -Ptasksng.skipRust
 *
 * Without TASKSNG_TEST_URL it is skipped. The screens are written to
 * app/build/screenshots.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-420dpi")
class ScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun shot(name: String) {
        rule.waitForIdle()
        captureScreenRoboImage("build/screenshots/$name.png")
    }

    /** Waits for work on other threads, letting what they post to the main thread run. */
    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30_000
        while (true) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) break
            if (System.currentTimeMillis() > deadline) throw AssertionError("Timed out waiting for $what")
            Thread.sleep(20)
        }
        rule.waitForIdle()
    }

    @Test
    fun signsInAndShowsEveryScreen() {
        val server = System.getProperty("tasksng.test.caldav").orEmpty()
        assumeTrue("TASKSNG_TEST_URL is not set", server.isNotEmpty())
        val app = ApplicationProvider.getApplicationContext<Application>()
        Graph.attach(app)
        val vm = TasksViewModel(app)
        rule.setContent { AppRoot(vm) }
        waitFor("the engine") { vm.ready.value }
        assertEquals(null, Graph.startError)
        shot("01-sign-in")

        var error: String? = "pending"
        vm.connect(server, "test", "test", false) { error = it }
        waitFor("signing in") { error != "pending" }
        assertEquals(null, error)
        waitFor("the lists") { vm.snapshot.value.lists.isNotEmpty() }
        val list = vm.snapshot.value.lists.first { !it.readOnly }

        // Start from an empty account, whatever an earlier run left behind.
        vm.delete(vm.snapshot.value.tasks.map { it.id })
        waitFor("an empty list") { vm.snapshot.value.tasks.isEmpty() }

        val now = ZonedDateTime.now()
        val lines = listOf(
            "Pay rent today !1 #home every month",
            "Call the dentist tomorrow 16:30 #health",
            "Water the plants yesterday every week",
            "Write the quarterly report tomorrow !2 #work",
            "Book flights fri #travel",
            "Read chapter 4",
            "Plan the garden from next week #home",
            "Renew passport in 3 days !1",
        )
        for (line in lines) vm.createFromQuickAdd(parseQuickAdd(line, now), list.id)
        waitFor("the tasks") { vm.snapshot.value.tasks.size == lines.size }
        val report = vm.snapshot.value.tasks.first { it.summary == "Write the quarterly report" }
        vm.createFromQuickAdd(parseQuickAdd("Collect the numbers", now), list.id, parentUid = report.uid)
        vm.createFromQuickAdd(parseQuickAdd("Draft the summary", now), list.id, parentUid = report.uid)
        vm.update(report.id, TaskPatch().description("Notes for the **report**:\n\n- [x] Outline\n- [ ] Charts\n- [ ] Review with Sam\n\nSee https://example.com/q3").status(TaskStatus.InProcess))
        val dentist = vm.snapshot.value.tasks.first { it.summary == "Call the dentist" }
        // Planned today, so the planner screenshot has two blocks; the reminder is tomorrow, so it is
        // still to come whatever the time of day the test runs.
        vm.plan(dentist.id, now.withHour(14).withMinute(0).withSecond(0).withNano(0).toInstant(), 45)
        val rent = vm.snapshot.value.tasks.first { it.summary == "Pay rent" }
        vm.plan(rent.id, now.withHour(10).withMinute(30).withSecond(0).withNano(0).toInstant(), 30)
        val read = vm.snapshot.value.tasks.first { it.summary == "Read chapter 4" }
        vm.toggleComplete(read.id)
        waitFor("the changes") { vm.snapshot.value.tasks.size == lines.size + 2 && vm.task(read.id)?.completed == true && vm.task(report.id)?.description?.isNotEmpty() == true }
        waitFor("the push") { vm.status.value.pending == 0 && vm.status.value.state == "idle" }

        // The engine parsed what the app sent, and the server kept it.
        val saved = vm.task(rent.id)!!
        assertEquals(1, saved.priority)
        assertEquals("FREQ=MONTHLY", saved.rrule)
        assertEquals(listOf("home"), saved.categories)
        assertNotNull(saved.planned)
        assertTrue(vm.counts.value.views.getValue(Views.TODAY) >= 2)

        vm.setView(Views.TODAY)
        shot("02-today")
        vm.setView(Views.list(list.id))
        shot("03-list")
        vm.setView(Views.UPCOMING)
        shot("04-upcoming")
        vm.setView(Views.PLAN)
        shot("05-planner")
        vm.setView(Views.OVERVIEW)
        shot("06-overview")

        vm.setView(Views.list(list.id))
        rule.onNodeWithContentDescription("Lists").performClick()
        shot("07-drawer")
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }

        vm.detailId.value = report.id
        shot("08-detail")
        rule.onNodeWithText("Repeat").performClick()
        shot("09-repeat")
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        vm.detailId.value = null

        vm.quickAdd.value = QuickAddRequest("Send invoice tomorrow 9am !1 #work every month")
        shot("10-quick-add")
        vm.quickAdd.value = null

        vm.screen.value = Screen.Settings
        shot("11-settings")
        vm.screen.value = Screen.Pairing()
        shot("12-pairing")
        vm.screen.value = Screen.Main

        vm.updatePrefs { it.copy(theme = ThemeMode.Dark, dynamicColor = false) }
        vm.setView(Views.TODAY)
        shot("13-today-dark")
        vm.detailId.value = report.id
        shot("14-detail-dark")
        vm.detailId.value = null
        vm.updatePrefs { it.copy(theme = ThemeMode.Light) }

        // Snoozing hides a task from Today; reminders are worked out by the engine.
        val before = vm.counts.value.views.getValue(Views.TODAY)
        vm.snooze(rent.id, now.plusHours(3).toInstant())
        waitFor("the snooze") { vm.counts.value.views.getValue(Views.TODAY) == before - 1 }
        val upcoming = runBlocking { Graph.engine.upcomingReminders(30, 50) }
        assertTrue("the dentist call has a reminder at its due time", upcoming.any { it.uid == dentist.uid })
        assertTrue("a snoozed task comes back with a notification", upcoming.any { it.uid == rent.uid && it.at / 1000 == now.plusHours(3).toInstant().epochSecond })
        assertEquals(iso(now.plusHours(3).toInstant()), vm.task(rent.id)?.snoozedUntil)

        // History and undo.
        val versions = runBlocking { vm.history(report.id) }
        assertTrue("edits within a few minutes are one version", versions.isNotEmpty())
        vm.delete(listOf(read.id))
        waitFor("the delete") { vm.task(read.id) == null }

        vm.signOut()
        waitFor("signing out") { vm.snapshot.value.account == null }
    }
}
