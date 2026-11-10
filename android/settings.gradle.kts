// Optional Maven Central mirror (e.g. Google's), for CI runners that hit
// Maven Central's per-IP rate limits (HTTP 429):
// TASKSNG_MAVEN_MIRROR=https://maven-central.storage-download.googleapis.com/maven2/
val mavenMirror: String? = System.getenv("TASKSNG_MAVEN_MIRROR")?.takeIf { it.isNotBlank() }

pluginManagement {
    repositories {
        google()
        System.getenv("TASKSNG_MAVEN_MIRROR")?.takeIf { it.isNotBlank() }?.let { maven(it) }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenMirror?.let { maven(it) }
        mavenCentral()
    }
}

rootProject.name = "TasksNG"
include(":app")
