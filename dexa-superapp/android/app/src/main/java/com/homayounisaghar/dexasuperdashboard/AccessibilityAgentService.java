package com.homayounisaghar.dexasuperdashboard;
import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.util.Log;
/** Opt-in service declaration for future owner-approved Android UI automation. */
public final class AccessibilityAgentService extends AccessibilityService {
    @Override protected void onServiceConnected() {super.onServiceConnected();Log.i("DexaAccessibility","SERVICE_CONNECTED");}
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // Do not collect or transmit private content by default.
    }
    @Override public void onInterrupt() {}
}
