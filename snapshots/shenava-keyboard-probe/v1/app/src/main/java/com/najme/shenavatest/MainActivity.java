package com.najme.shenavatest;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, float sp) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(sp);
        v.setTextColor(Color.rgb(32, 32, 36));
        v.setGravity(Gravity.RIGHT);
        v.setTextDirection(View.TEXT_DIRECTION_RTL);
        return v;
    }

    private Button button(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(15);
        b.setAllCaps(false);
        return b;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final int baseLeft = dp(20);
        final int baseTop = dp(22);
        final int baseRight = dp(20);
        final int baseBottom = dp(20);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(baseLeft, baseTop, baseRight, baseBottom);
        root.setBackgroundColor(Color.rgb(250, 250, 250));
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int left = insets.getSystemWindowInsetLeft();
            int top = insets.getSystemWindowInsetTop();
            int right = insets.getSystemWindowInsetRight();
            int bottom = insets.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= 28) {
                DisplayCutout cutout = insets.getDisplayCutout();
                if (cutout != null) {
                    left = Math.max(left, cutout.getSafeInsetLeft());
                    top = Math.max(top, cutout.getSafeInsetTop());
                    right = Math.max(right, cutout.getSafeInsetRight());
                    bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                }
            }
            v.setPadding(baseLeft + left, baseTop + top, baseRight + right, baseBottom + bottom);
            return insets;
        });

        TextView title = text("آزمایش مستقل کیبورد شنوا", 24);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView info = text("این برنامه کاملاً جدا از Persian Keyboard فعلی نصب می‌شود. تشخیص گفتار با Shenava Rizeh روی خود گوشی انجام می‌شود و این نسخه عمداً مجوز اینترنت ندارد.", 15);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(-1, -2);
        infoLp.topMargin = dp(12);
        root.addView(info, infoLp);

        TextView model = text("مدل: Shenava Rizeh v1.0 streaming INT8 • موتور: sherpa-onnx 1.13.8", 13);
        LinearLayout.LayoutParams modelLp = new LinearLayout.LayoutParams(-1, -2);
        modelLp.topMargin = dp(8);
        root.addView(model, modelLp);

        Button permission = button("دادن مجوز میکروفون");
        permission.setOnClickListener(v -> requestMicPermission());
        LinearLayout.LayoutParams p1 = new LinearLayout.LayoutParams(-1, dp(52));
        p1.topMargin = dp(18);
        root.addView(permission, p1);

        Button enable = button("فعال‌کردن Shenava Local Keyboard");
        enable.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)));
        LinearLayout.LayoutParams p2 = new LinearLayout.LayoutParams(-1, dp(52));
        p2.topMargin = dp(8);
        root.addView(enable, p2);

        Button choose = button("انتخاب کیبورد برای تست");
        choose.setOnClickListener(v -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showInputMethodPicker();
        });
        LinearLayout.LayoutParams p3 = new LinearLayout.LayoutParams(-1, dp(52));
        p3.topMargin = dp(8);
        root.addView(choose, p3);

        EditText test = new EditText(this);
        test.setHint("اینجا بزن و با دکمهٔ میکروفون کیبورد صحبت کن…");
        test.setTextSize(18);
        test.setGravity(Gravity.RIGHT | Gravity.TOP);
        test.setTextDirection(View.TEXT_DIRECTION_RTL);
        test.setMinLines(5);
        test.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams editLp = new LinearLayout.LayoutParams(-1, 0, 1f);
        editLp.topMargin = dp(16);
        root.addView(test, editLp);

        TextView note = text("برای مقایسهٔ منصفانه، فعلاً متن خام مدل را می‌بینی؛ post-processing و اصلاح اعداد را عمداً وارد این تست نکرده‌ام.", 12);
        LinearLayout.LayoutParams noteLp = new LinearLayout.LayoutParams(-1, -2);
        noteLp.topMargin = dp(10);
        root.addView(note, noteLp);

        setContentView(root);
        root.requestApplyInsets();

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestMicPermission();
        }
    }

    private void requestMicPermission() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1001);
        }
    }
}
