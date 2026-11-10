# The engine is called through JNI by name.
-keep class app.tasksng.android.core.Native { *; }

# kotlinx.serialization: keep the generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class app.tasksng.android.** {
    *** Companion;
}
-keepclasseswithmembers class app.tasksng.android.** {
    kotlinx.serialization.KSerializer serializer(...);
}
