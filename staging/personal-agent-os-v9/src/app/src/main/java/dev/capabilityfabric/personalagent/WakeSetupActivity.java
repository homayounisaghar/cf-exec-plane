package dev.capabilityfabric.personalagent;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

public class WakeSetupActivity extends Activity {
    private static final String START_URL = "https://www.perplexity.ai/";
    private static final String MOBILE_BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36";

    private TextView status;
    private WebView webView;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(14), dp(14), dp(14), dp(14));
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("Perplexity session");
        title.setTextSize(21f);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(4), 0, dp(8));
        root.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        status = new TextView(this);
        status.setText("Loading Perplexity…");
        status.setGravity(Gravity.CENTER);
        status.setTextSize(12f);
        status.setPadding(0, 0, 0, dp(8));
        root.addView(status);

        TextView hint = new TextView(this);
        hint.setText("If Perplexity asks you to sign in or complete a normal verification, do it here. This session is used only to obtain the speech credential.");
        hint.setTextSize(12f);
        hint.setPadding(dp(3), 0, dp(3), dp(8));
        root.addView(hint);

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        configureWebView();
        webView.loadUrl(START_URL);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(MOBILE_BROWSER_UA);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                String host = null;
                try { host = Uri.parse(url).getHost(); } catch (Exception ignored) {}
                boolean ok = host != null &&
                        (host.equals("perplexity.ai") || host.endsWith(".perplexity.ai"));
                if (ok) {
                    try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
                    status.setText("Perplexity session is loaded. You can go back to the probe.");
                } else {
                    status.setText("Waiting for Perplexity…");
                }
            }
        });
    }

    @Override protected void onDestroy() {
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
