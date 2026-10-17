plugins { id("com.android.application") }
android { namespace = "dev.capabilityfabric.personalagent"; compileSdk = 35
  defaultConfig { applicationId = "dev.capabilityfabric.personalagent"; minSdk = 26; targetSdk = 35; versionCode = 8; versionName = "0.7.0-alpha7" }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  buildTypes { getByName("release") { isMinifyEnabled = false } }
}

dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }
