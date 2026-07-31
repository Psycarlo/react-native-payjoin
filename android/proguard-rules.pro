# Consumer ProGuard rules for react-native-payjoin.
#
# Referenced by `consumerProguardFiles` in build.gradle, so this file must
# exist even when empty — these rules are applied to the consuming app.

# The TurboModule is instantiated reflectively by React Native's module
# registry, and its `nativeInstallRustCrate` / `nativeCleanupRustCrate`
# methods are resolved from JNI by name. Keep both from being renamed or
# stripped.
-keep class com.reactnativepayjoin.** { *; }

# JNI entry points are looked up by their exact symbol names.
-keepclasseswithmembernames class * {
    native <methods>;
}
