import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// The version comes from the workspace Cargo.toml, so the engine, the web
// server and the app always agree. Releases pass -Ptasksng.versionName=1.2.3.
val workspaceVersion: String = rootProject.file("../Cargo.toml").readLines()
    .firstOrNull { it.trim().startsWith("version = ") }
    ?.substringAfter('"')?.substringBefore('"') ?: "0.0.0"
val appVersion: String = providers.gradleProperty("tasksng.versionName").orNull?.takeIf { it.isNotBlank() } ?: workspaceVersion

/** 1.2.3 -> 10203, so every release installs over the one before. */
fun versionCodeOf(v: String): Int {
    val (major, minor, patch) = (v.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 } + listOf(0, 0, 0)).take(3)
    require(minor < 100 && patch < 100) { "Version $v: minor and patch must be below 100" }
    return major * 10000 + minor * 100 + patch
}

// Release signing key: environment variables in CI (from repository secrets),
// or android/keystore.properties on a developer's machine. Without one,
// release builds are signed with the debug key so they can still be installed.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signing(name: String, env: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProperties.getProperty(name)

android {
    namespace = "app.tasksng.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.tasksng.android"
        minSdk = 26
        targetSdk = 37
        versionCode = providers.gradleProperty("tasksng.versionCode").orNull?.toIntOrNull() ?: versionCodeOf(appVersion)
        versionName = appVersion
        ndk {
            // 32-bit x86 phones no longer exist; x86_64 is for emulators.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    signingConfigs {
        val storeFile = signing("storeFile", "TASKSNG_KEYSTORE_FILE")
        if (storeFile != null && file(storeFile).exists()) {
            create("release") {
                this.storeFile = file(storeFile)
                storePassword = signing("storePassword", "TASKSNG_KEYSTORE_PASSWORD")
                keyAlias = signing("keyAlias", "TASKSNG_KEY_ALIAS")
                keyPassword = signing("keyPassword", "TASKSNG_KEY_PASSWORD") ?: signing("storePassword", "TASKSNG_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        // The engine (crates/tasks-android), built by the cargoNdk task below.
        getByName("main").jniLibs.directories.add(layout.buildDirectory.dir("rustJniLibs").get().asFile.path)
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all { test ->
            // The engine built for this computer (`cargo build -p tasks-android`):
            // the screen tests run it for real when it is there.
            test.systemProperty("java.library.path", rootProject.file("../target/debug").path)
            test.systemProperty("tasksng.test.caldav", System.getenv("TASKSNG_TEST_URL") ?: "")
            test.systemProperty("robolectric.graphicsMode", "NATIVE")
            test.systemProperty("roborazzi.test.record", "true")
            System.getenv("TASKSNG_MAVEN_MIRROR")?.takeIf { it.isNotBlank() }?.let { test.systemProperty("robolectric.dependency.repo.url", it.trimEnd('/')) }
            test.maxHeapSize = "2g"
        }
    }
}

// Builds the Rust engine for every ABI with cargo-ndk (`cargo install
// cargo-ndk`, plus the Rust targets and the Android NDK). Pass
// -Ptasksng.skipRust to use libraries already in build/rustJniLibs.
val cargoNdk = tasks.register<Exec>("cargoNdk") {
    group = "build"
    description = "Builds the Rust sync engine for Android"
    val out = layout.buildDirectory.dir("rustJniLibs")
    val abis = providers.gradleProperty("tasksng.abis").orNull?.split(',') ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")
    workingDir = rootProject.file("..")
    commandLine(
        listOf("cargo", "ndk") + abis.flatMap { listOf("-t", it) } +
            listOf("--platform", "26", "-o", out.get().asFile.path, "build", "-p", "tasks-android", "--release"),
    )
    inputs.files(fileTree(rootProject.file("../crates")) { include("**/*.rs", "**/Cargo.toml") }, rootProject.file("../Cargo.lock"))
    outputs.dir(out)
    enabled = !providers.gradleProperty("tasksng.skipRust").isPresent
}
tasks.named("preBuild") { dependsOn(cargoNdk) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-process:2.11.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    // Reordering tasks by hand in a list.
    implementation("sh.calvin.reorderable:reorderable:3.1.0")
    // Scanning the pairing code the web app shows.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    // Screens drawn on the JVM, for the screenshot tests.
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("androidx.test.ext:junit:1.3.0")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.78.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.78.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
