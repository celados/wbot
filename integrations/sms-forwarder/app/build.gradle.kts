plugins { id("com.android.application") }
android {
    namespace = "cc.celados.sms"
    compileSdk = 37
    defaultConfig {
        applicationId = "cc.celados.sms"
        minSdk = 35
        targetSdk = 35
        versionCode = 5
        versionName = "0.5.0"
        testInstrumentationRunner = "cc.celados.sms.SpoolCheck"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}
