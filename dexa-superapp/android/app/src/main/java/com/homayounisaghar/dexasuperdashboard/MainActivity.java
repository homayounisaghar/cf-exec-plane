package com.homayounisaghar.dexasuperdashboard;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String HOME = "https://chatgpt.com/";
    private static final String DASHBOARD = "https://dexa-super-dashboard-20261105.onrender.com/";
    private static final String DASH_HOST = "dexa-super-dashboard-20261105.onrender.com";
    private static final int MAX_BROWSER = 8;
    private static final int AUDIO_REQUEST = 4017;
    private final ArrayList<WebView> browsers = new ArrayList<>();
    private final Map<WebView,WebView> popupParents = new HashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SharedPreferences state;
    private Telemetry telemetry;
    private FrameLayout surfaces;
    private LinearLayout root;
    private WebView dashboard;
    private TextView title;
    private Button backToDashboard;
    private boolean showingDashboard = true;
    private int activeSlot = -1;
    private PermissionRequest pendingAudioRequest;
    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            if (telemetry != null) telemetry.flushAsync();
            mainHandler.postDelayed(this, 25000);
        }
    };

    @Override @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstance) {
        super.onCreate(savedInstance);
        state = getSharedPreferences("dexa_super_state_v1", Context.MODE_PRIVATE);
        telemetry = new Telemetry(this);
        Thread.UncaughtExceptionHandler old = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                telemetry.record("JAVA_CRASH", -1, Telemetry.meta("code", error.getClass().getSimpleName()));
            } catch (Throwable ignored) {}
            if (old != null) old.uncaughtException(thread, error);
        });
        CookieManager.getInstance().setAcceptCookie(true);
        getWindow().setStatusBarColor(Color.rgb(244,248,249));
        getWindow().setNavigationBarColor(Color.rgb(244,248,249));
        if (Build.VERSION.SDK_INT >= 26) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(244,248,249));
        root.setFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v,insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28) {
                    DisplayCutout cutout = insets.getDisplayCutout();
                    if (cutout != null) {
                        left = Math.max(left,cutout.getSafeInsetLeft());
                        top = Math.max(top,cutout.getSafeInsetTop());
                        right = Math.max(right,cutout.getSafeInsetRight());
                        bottom = Math.max(bottom,cutout.getSafeInsetBottom());
                    }
                }
            }
            v.setPadding(left,top,right,bottom);
            return insets;
        });

        LinearLayout chrome = new LinearLayout(this);
        chrome.setOrientation(LinearLayout.HORIZONTAL);
        chrome.setGravity(Gravity.CENTER_VERTICAL);
        chrome.setPadding(dp(9),dp(5),dp(9),dp(5));
        chrome.setBackgroundColor(Color.WHITE);
        backToDashboard = makeButton("پنل دکسا", () -> showDashboard(true));
        chrome.addView(backToDashboard, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,dp(45)));
        title = new TextView(this);
        title.setText("داشبورد دکسا");
        title.setGravity(Gravity.CENTER);
        title.setTextColor(Color.rgb(16,59,70));
        title.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        title.setTextSize(14);
        chrome.addView(title,new LinearLayout.LayoutParams(0,dp(45),1));
        Button reload = makeButton("↻", () -> {
            if (showingDashboard) { dashboard.reload(); telemetry.record("DASHBOARD_REFRESH",-1,null); }
            else if (activeSlot>=0 && activeSlot<browsers.size()) {browsers.get(activeSlot).reload();telemetry.record("BROWSER_REFRESH",activeSlot,null);}
        });
        chrome.addView(reload,new LinearLayout.LayoutParams(dp(44),dp(45)));
        root.addView(chrome, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT));

        surfaces = new FrameLayout(this);
        surfaces.setBackgroundColor(Color.WHITE);
        root.addView(surfaces,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));
        setContentView(root);
        root.requestApplyInsets();

        dashboard = makeWebView(-1,true);
        dashboard.addJavascriptInterface(new DashboardBridge(),"DexaHost");
        surfaces.addView(dashboard, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        int count = Math.max(1,Math.min(MAX_BROWSER,state.getInt("browser_count",2)));
        for (int i=0;i<count;i++) createBrowser(i);
        showDashboard(false);
        dashboard.loadUrl(DASHBOARD);
        telemetry.record("APP_BOOT",-1,Telemetry.meta("count",count));
        mainHandler.postDelayed(heartbeat,1500);
    }

    private int dp(float number) {return (int)(getResources().getDisplayMetrics().density*number+0.5f);}
    private Button makeButton(String text,Runnable onClick) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        b.setTextColor(Color.rgb(8,97,111));
        b.setPadding(dp(6),0,dp(6),0);
        b.setOnClickListener(v->onClick.run());
        return b;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView makeWebView(int slot, boolean isDashboard) {
        WebView w = new WebView(this);
        w.setBackgroundColor(Color.WHITE);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(!isDashboard);
        s.setJavaScriptCanOpenWindowsAutomatically(!isDashboard);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w,true);
        w.setWebViewClient(new BrowserClient(slot,isDashboard));
        w.setWebChromeClient(new BrowserChrome(slot,isDashboard));
        return w;
    }

    private void createBrowser(int slot) {
        WebView w = makeWebView(slot,false);
        w.setVisibility(View.INVISIBLE);
        browsers.add(w);
        surfaces.addView(w,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        String url = state.getString("browser_url_"+slot,HOME);
        if (!isHttpsUrl(url)) url=HOME;
        w.loadUrl(url);
        telemetry.record("BROWSER_CREATED",slot,Telemetry.meta("count",browsers.size()));
    }

    private void changeCount(int requested) {
        int number=Math.max(1,Math.min(MAX_BROWSER,requested));
        while(browsers.size()<number)createBrowser(browsers.size());
        while(browsers.size()>number) {
            int index=browsers.size()-1;
            WebView w=browsers.remove(index);
            surfaces.removeView(w);
            w.stopLoading(); w.destroy();
            state.edit().remove("browser_url_"+index).apply();
            telemetry.record("BROWSER_REMOVED",index,null);
        }
        state.edit().putInt("browser_count",number).commit();
        if (activeSlot>=number)showDashboard(false);
        postStatus();
    }

    private void showBrowser(int slot) {
        if(slot<0||slot>=browsers.size())return;
        for(WebView v:browsers)v.setVisibility(View.INVISIBLE);
        dashboard.setVisibility(View.INVISIBLE);
        WebView chosen=browsers.get(slot);
        chosen.setVisibility(View.VISIBLE);
        chosen.bringToFront();
        chosen.requestFocus();
        activeSlot=slot;
        showingDashboard=false;
        title.setText("مرورگر "+(slot+1));
        telemetry.record("BROWSER_SHOWN",slot,Telemetry.meta("visible",true));
        postStatus();
    }

    private void showDashboard(boolean manual) {
        for(WebView v:browsers)v.setVisibility(View.INVISIBLE);
        for(WebView popup:new ArrayList<>(popupParents.keySet()))popup.setVisibility(View.INVISIBLE);
        dashboard.setVisibility(View.VISIBLE);
        dashboard.bringToFront();
        showingDashboard=true;
        activeSlot=-1;
        title.setText("داشبورد دکسا");
        if(manual && telemetry!=null)telemetry.record("DASHBOARD_SHOWN",-1,Telemetry.meta("visible",true));
        postStatus();
    }

    private static boolean isHttpsUrl(String url) {
        try { Uri u=Uri.parse(url);return "https".equalsIgnoreCase(u.getScheme())&&u.getHost()!=null&&!u.getHost().isEmpty();}
        catch(Exception e){return false;}
    }
    private String hostOf(String url) {
        try {String h=Uri.parse(url).getHost();return h==null?"UNKNOWN":h.substring(0,Math.min(95,h.length()));}
        catch(Exception e){return "UNKNOWN";}
    }
    private boolean dashboardOrigin() {
        return dashboard!=null && DASH_HOST.equalsIgnoreCase(hostOf(dashboard.getUrl()));
    }
    private JSONObject status() {
        JSONObject r = new JSONObject();
        try {
            r.put("schema","dexa-host.v1");
            r.put("count",browsers.size());
            r.put("max",MAX_BROWSER);
            r.put("showingDashboard",showingDashboard);
            r.put("activeSlot",activeSlot);
            r.put("pending",telemetry.pending());
            r.put("lastHttp",telemetry.lastHttp());
            r.put("lastAck",telemetry.lastAckMs());
            r.put("deviceShort",telemetry.deviceShort());
            JSONArray list=new JSONArray();
            for(int i=0;i<browsers.size();i++) {
                WebView w=browsers.get(i);
                JSONObject b=new JSONObject();
                b.put("slot",i);
                b.put("visible",w.getVisibility()==View.VISIBLE);
                b.put("url",w.getUrl()==null?HOME:w.getUrl());
                b.put("progress",w.getProgress());
                list.put(b);
            }
            r.put("browsers",list);
        } catch(Exception ignored){}
        return r;
    }

    private void postStatus() {
        if(dashboard!=null && dashboardOrigin()) {
            JSONObject current=status();
            dashboard.evaluateJavascript("window.onDexaHostUpdate&&window.onDexaHostUpdate("+current.toString()+")",null);
        }
    }
    private void reply(String id, boolean ok, String reason, Object result) {
        JSONObject r = new JSONObject();
        try{
            r.put("ok",ok);
            if(!ok)r.put("reason",reason==null?"FAILED":reason);
            if(result!=null)r.put("result",result);
            r.put("state",status());
        }catch(Exception ignored){}
        if(dashboard!=null && dashboardOrigin())
            dashboard.evaluateJavascript("window.DexaResolve&&window.DexaResolve("+JSONObject.quote(id)+","+r.toString()+")",null);
    }

    private final class DashboardBridge {
        @JavascriptInterface public void send(String raw) {
            if(raw==null || raw.length()>20000)return;
            runOnUiThread(()->{
                if(!dashboardOrigin()) {telemetry.record("BRIDGE_ORIGIN_REJECT",-1,null);return;}
                try {
                    JSONObject o=new JSONObject(raw);
                    String id=o.optString("id","");
                    String op=o.optString("op","");
                    if(id.length()<1 || id.length()>80)return;
                    telemetry.record("BRIDGE_COMMAND",-1,Telemetry.meta("phase",op.substring(0,Math.min(op.length(),48))));
                    switch(op) {
                        case "status":
                            reply(id,true,null,status());break;
                        case "set-count":
                            int count=o.optInt("count",-1);
                            if(count<1||count>MAX_BROWSER){reply(id,false,"COUNT_OUT_OF_RANGE",null);break;}
                            changeCount(count);reply(id,true,null,status());break;
                        case "show":
                            int slot=o.optInt("slot",-1);
                            if(slot<0||slot>=browsers.size()){reply(id,false,"SLOT_NOT_FOUND",null);break;}
                            showBrowser(slot);reply(id,true,null,null);break;
                        case "hide":
                            showDashboard(true);reply(id,true,null,null);break;
                        case "reload":
                            int refresh=o.optInt("slot",-1);
                            if(refresh<0||refresh>=browsers.size()){reply(id,false,"SLOT_NOT_FOUND",null);break;}
                            browsers.get(refresh).reload();reply(id,true,null,null);break;
                        case "navigate":
                            int n=o.optInt("slot",-1);
                            String url=o.optString("url","");
                            if(n<0||n>=browsers.size()){reply(id,false,"SLOT_NOT_FOUND",null);break;}
                            if(!isHttpsUrl(url)){reply(id,false,"HTTPS_REQUIRED",null);break;}
                            browsers.get(n).loadUrl(url);
                            telemetry.record("BROWSER_NAVIGATE",n,Telemetry.meta("host",hostOf(url)));
                            reply(id,true,null,null);break;
                        case "eval":
                            int target=o.optInt("slot",-1);
                            String script=o.optString("script","");
                            if(target<0||target>=browsers.size()){reply(id,false,"SLOT_NOT_FOUND",null);break;}
                            if(script.isEmpty()||script.length()>12000){reply(id,false,"SCRIPT_INVALID",null);break;}
                            WebView selected=browsers.get(target);
                            final String requestId=id;
                            String wrapper="(function(){try{return JSON.stringify({ok:true,result:("+script+")});}catch(e){return JSON.stringify({ok:false,reason:String(e&&e.name)})}})()";
                            selected.evaluateJavascript(wrapper,val->{
                                telemetry.record("SCRIPT_RESULT",target,Telemetry.meta("ok",val!=null && !"null".equals(val)));
                                reply(requestId,true,null,val==null?"null":val);
                            });
                            break;
                        default:
                            reply(id,false,"UNKNOWN_COMMAND",null);
                    }
                }catch(Exception e){
                    telemetry.record("BRIDGE_ERROR",-1,Telemetry.meta("code",e.getClass().getSimpleName()));
                }
            });
        }
    }

    private final class BrowserClient extends WebViewClient {
        private final int slot;
        private final boolean isDashboard;
        BrowserClient(int slot,boolean dashboard){this.slot=slot;isDashboard=dashboard;}
        @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon) {
            telemetry.record("PAGE_START",slot,Telemetry.meta("host",hostOf(url)));
        }
        @Override public void onPageFinished(WebView view,String url) {
            telemetry.record("PAGE_FINISH",slot,Telemetry.meta("host",hostOf(url)));
            if(!isDashboard && slot>=0 && slot<browsers.size() && browsers.get(slot)==view && isHttpsUrl(url)) {
                state.edit().putString("browser_url_"+slot,url).apply();
            }
            postStatus();
        }
        @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) {
            if(request.isForMainFrame())telemetry.record("WEBVIEW_ERROR",slot,Telemetry.meta("host",hostOf(request.getUrl().toString()),"code",error.getErrorCode()));
        }
        @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response) {
            if(request.isForMainFrame())telemetry.record("HTTP_ERROR",slot,Telemetry.meta("host",hostOf(request.getUrl().toString()),"code",response.getStatusCode()));
        }
        @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error) {
            handler.cancel();
            telemetry.record("TLS_ERROR",slot,Telemetry.meta("code",error.getPrimaryError()));
        }
    }

    private final class BrowserChrome extends WebChromeClient {
        private final int slot;
        private final boolean isDashboard;
        BrowserChrome(int slot,boolean dashboard){this.slot=slot;this.isDashboard=dashboard;}
        @Override public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(()->{
                String origin=request.getOrigin().getHost();
                String[] resources=request.getResources();
                if(isDashboard || !"chatgpt.com".equalsIgnoreCase(origin)
                   || resources.length!=1 || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0])) {
                    request.deny();telemetry.record("MEDIA_DENIED",slot,null);return;
                }
                if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    telemetry.record("MEDIA_GRANTED",slot,Telemetry.meta("ok",true));
                }else{
                    pendingAudioRequest=request;
                    telemetry.record("MEDIA_PERMISSION_PROMPT",slot,null);
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},AUDIO_REQUEST);
                }
            });
        }
        @Override public boolean onCreateWindow(WebView view,boolean isDialog,boolean isUserGesture,Message resultMsg) {
            if(isDashboard||!isUserGesture)return false;
            WebView popup=makeWebView(slot,false);
            popupParents.put(popup,view);
            surfaces.addView(popup,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
            popup.setVisibility(View.VISIBLE);
            popup.bringToFront();
            telemetry.record("POPUP_OPENED",slot,Telemetry.meta("visible",true));
            WebView.WebViewTransport transport=(WebView.WebViewTransport)resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
        @Override public void onCloseWindow(WebView window) {
            closePopup(window);
        }
    }

    private void closePopup(WebView popup) {
        if(!popupParents.containsKey(popup))return;
        WebView parent=popupParents.remove(popup);
        surfaces.removeView(popup);
        popup.stopLoading();popup.destroy();
        if(parent!=null && !showingDashboard) {
            parent.setVisibility(View.VISIBLE);
            parent.bringToFront();
        }
        telemetry.record("POPUP_CLOSED",activeSlot,null);
    }

    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(code,permissions,results);
        if(code!=AUDIO_REQUEST||pendingAudioRequest==null)return;
        PermissionRequest request=pendingAudioRequest;
        pendingAudioRequest=null;
        if(results.length>0 && results[0]==PackageManager.PERMISSION_GRANTED){
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            telemetry.record("MEDIA_GRANTED",activeSlot,Telemetry.meta("ok",true));
        }else{
            request.deny();telemetry.record("MEDIA_DENIED",activeSlot,null);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if(telemetry!=null)telemetry.record("ACTIVITY_RESUME",activeSlot,null);
    }
    @Override protected void onPause() {
        if(telemetry!=null)telemetry.record("ACTIVITY_PAUSE",activeSlot,null);
        super.onPause();
    }
    @Override public void onBackPressed() {
        if(!popupParents.isEmpty()){
            WebView popup=new ArrayList<>(popupParents.keySet()).get(popupParents.size()-1);
            if(popup.canGoBack()){popup.goBack();return;}
            closePopup(popup);return;
        }
        if(!showingDashboard){
            WebView w=browsers.get(activeSlot);
            if(w.canGoBack()){w.goBack();return;}
            showDashboard(true);return;
        }
        if(dashboard.canGoBack()){dashboard.goBack();return;}
        super.onBackPressed();
    }
    @Override protected void onDestroy() {
        mainHandler.removeCallbacks(heartbeat);
        if(telemetry!=null)telemetry.record("ACTIVITY_DESTROY",activeSlot,null);
        super.onDestroy();
    }
}
