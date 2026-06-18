package com.microgentic.voyager

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Route the Android system back gesture/button to the WebView's history so
  // back goes thread -> conversation list (and exits at the root), matching
  // native messenger behavior. TauriActivity opts out by default (false).
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
