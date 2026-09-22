package com.homayounisaghar.exitbutton;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);

        Button exit = new Button(this);
        exit.setText("خروج");
        exit.setTextSize(22f);
        exit.setOnClickListener(v -> finishAndRemoveTask());

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        );
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        exit.setPadding(pad, pad / 2, pad, pad / 2);
        root.addView(exit, lp);

        setContentView(root);
    }
}
