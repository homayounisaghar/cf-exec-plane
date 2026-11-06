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
    private static final int MAX_SCRIPT_BYTES_IN_MEMORY = 4 * 1024 * 1024;
    private final Map<String, ScriptTransfer> pendingScripts = new HashMap<>();
    private static final class ScriptTransfer {
        final int slot;
        final String startUrl;
        final boolean remote;
        final StringBuilder content = new StringBuilder();
        final long created = System.currentTimeMillis();
        ScriptTransfer(int slot,String startUrl,boolean remote) { this.slot = slot; this.startUrl=startUrl; this.remote=remote; }
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SharedPreferences state;
    private Telemetry telemetry;
    private PermissionGateway permissionGateway;
    private FrameLayout surfaces;
    private LinearLayout root;
    private WebView dashboard;
    private WebView chrome;
    private FrameLayout chromeHolder;
    private Button emergencyPanel;
    private boolean chromeFailed = false;
    private boolean remoteArmed = false;
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
        remoteArmed = state.getBoolean("remote_armed_v15",false);
        telemetry = new Telemetry(this);
        permissionGateway = new PermissionGateway(this,telemetry);
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

        // The entire upper chrome is an independently loaded remote web document.
        // Native code only retains the host, a bounded bridge and an offline rescue path.
        chromeHolder = new FrameLayout(this);
        chromeHolder.setBackgroundColor(Color.rgb(255,242,231));
        chrome = makeWebView(-2,true);
        chrome.addJavascriptInterface(new ChromeBridge(),"DexaChrome");
        chromeHolder.addView(chrome, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        emergencyPanel = makeButton("پنل دکسا — بازگشت اضطراری", () -> showDashboard(true));
        emergencyPanel.setVisibility(View.GONE);
        chromeHolder.addView(emergencyPanel,new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(chromeHolder,new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,dp(64)));

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
        chrome.loadUrl(DASHBOARD+"toolbar");
        telemetry.record("APP_BOOT",-1,Telemetry.meta("count",count));
        telemetry.record("CHROME_BOOT",-2,null);
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
        return dashboard!=null && isHttpsUrl(dashboard.getUrl()) && DASH_HOST.equalsIgnoreCase(hostOf(dashboard.getUrl()));
    }
    private boolean isChromeUrl(String url) {
        if (!isHttpsUrl(url) || !DASH_HOST.equalsIgnoreCase(hostOf(url))) return false;
        try {return "/toolbar".equals(Uri.parse(url).getPath());}
        catch(Exception ignored) {return false;}
    }
    private boolean chromeOrigin() {return chrome!=null && isChromeUrl(chrome.getUrl());}
    private void showChromeFallback(boolean show) {
        if (emergencyPanel!=null) emergencyPanel.setVisibility(show ? View.VISIBLE : View.GONE);
    }
    private void setChromeHeight(int heightDp) {
        if (heightDp<48 || heightDp>240) {telemetry.record("CHROME_HEIGHT_REJECT",-2,Telemetry.meta("code","OUT_OF_RANGE"));return;}
        ViewGroup.LayoutParams p=chromeHolder.getLayoutParams();
        if(p!=null && p.height!=dp(heightDp)) {p.height=dp(heightDp);chromeHolder.setLayoutParams(p);}
    }
    private JSONObject status() {
        JSONObject r = new JSONObject();
        try {
            r.put("schema","dexa-host.v1");
            r.put("appVersionCode",5);
            r.put("remoteArmed",remoteArmed);
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
        JSONObject current=status();
        if(dashboard!=null && dashboardOrigin()) {
            dashboard.evaluateJavascript("window.onDexaHostUpdate&&window.onDexaHostUpdate("+current.toString()+")",null);
        }
        if(chrome!=null && chromeOrigin()) {
            chrome.evaluateJavascript("window.onDexaChromeState&&window.onDexaChromeState("+current.toString()+")",null);
        }
    }
    private void chromeReply(String id, boolean ok, String reason) {
        if(!chromeOrigin())return;
        JSONObject data=new JSONObject();
        try {data.put("ok",ok);if(!ok)data.put("reason",reason);data.put("state",status());}
        catch(Exception ignored){}
        chrome.evaluateJavascript("window.DexaChromeResponse&&window.DexaChromeResponse("+JSONObject.quote(id)+","+data.toString()+")",null);
    }
    private final class ChromeBridge {
        @JavascriptInterface public void send(String raw) {
            if(raw==null||raw.length()>2000)return;
            runOnUiThread(()->{
                if(!chromeOrigin()){telemetry.record("CHROME_ORIGIN_REJECT",-2,null);return;}
                try {
                    JSONObject m=new JSONObject(raw);
                    String id=m.optString("id",""),op=m.optString("op","");
                    if(id.length()<1||id.length()>64)return;
                    telemetry.record("CHROME_COMMAND",-2,Telemetry.meta("phase",op.substring(0,Math.min(op.length(),45))));
                    switch(op) {
                        case "status":chromeReply(id,true,null);break;
                        case "dashboard":showDashboard(true);chromeReply(id,true,null);break;
                        case "show-slot":
                            int slot=m.optInt("slot",-1);
                            if(slot<0||slot>=browsers.size()){chromeReply(id,false,"SLOT_NOT_FOUND");break;}
                            showBrowser(slot);chromeReply(id,true,null);break;
                        case "reload-active":
                            if(showingDashboard){dashboard.reload();telemetry.record("DASHBOARD_REFRESH",-1,null);}
                            else if(activeSlot>=0&&activeSlot<browsers.size()){
                                browsers.get(activeSlot).reload();telemetry.record("BROWSER_REFRESH",activeSlot,null);
                            }
                            chromeReply(id,true,null);break;
                        case "update-web":
                            dashboard.reload();
                            chromeReply(id,true,null);
                            telemetry.record("WEB_BUNDLE_RELOAD",-2,null);
                            chrome.reload();
                            break;
                        case "set-height":
                            int h=m.optInt("height",0);
                            if(h<48||h>240){chromeReply(id,false,"HEIGHT_OUT_OF_RANGE");break;}
                            setChromeHeight(h);chromeReply(id,true,null);break;
                        default:chromeReply(id,false,"UNKNOWN_CHROME_COMMAND");
                    }
                }catch(Exception e){telemetry.record("CHROME_ERROR",-2,Telemetry.meta("code",e.getClass().getSimpleName()));}
            });
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
                        case "remote-arm": {
                            boolean wanted=o.optBoolean("enabled",false);
                            remoteArmed=wanted;
                            state.edit().putBoolean("remote_armed_v15",wanted).apply();
                            telemetry.record("REMOTE_ARM",-1,Telemetry.meta("ok",wanted));
                            reply(id,true,null,status());
                            postStatus();
                            break;
                        }

                        case "permissions-status":
                            JSONArray keys=o.optJSONArray("keys");
                            if(keys==null || keys.length()>70){reply(id,false,"INVALID_PERMISSION_LIST",null);break;}
                            JSONArray statuses=new JSONArray();
                            for(int k=0;k<keys.length();k++){
                                String key=keys.optString(k,"");
                                if(key.length()>120){reply(id,false,"INVALID_PERMISSION_ID",null);statuses=null;break;}
                                statuses.put(permissionGateway.status(key));
                            }
                            if(statuses!=null)reply(id,true,null,statuses);
                            break;
                        case "permission-request":
                            String key=o.optString("key","");
                            if(key.length()<1 || key.length()>120){reply(id,false,"INVALID_PERMISSION_ID",null);break;}
                            JSONObject outcome=permissionGateway.request(key);
                            reply(id,outcome.optBoolean("ok"),outcome.optString("code","FAILED"),outcome);
                            break;
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
                        case "eval-begin": {
                            int slotValue=o.optInt("slot",-1);
                            String run=o.optString("runId","");
                            if(slotValue<0||slotValue>=browsers.size() || !run.matches("[a-zA-Z0-9_-]{8,80}")){
                                reply(id,false,"INVALID_SCRIPT_RUN",null);break;
                            }
                            pendingScripts.entrySet().removeIf(e ->
                                    System.currentTimeMillis()-e.getValue().created>180000);
                            if(pendingScripts.containsKey(run) || pendingScripts.size()>=8){
                                reply(id,false,"TRANSFER_BUSY",null);break;
                            }
                            boolean remote=o.optBoolean("remote",false);
                            if(remote&&!remoteArmed){reply(id,false,"REMOTE_DISABLED",null);break;}
                            pendingScripts.put(run,new ScriptTransfer(slotValue,browsers.get(slotValue).getUrl(),remote));
                            telemetry.record("SCRIPT_BEGIN",slotValue,Telemetry.meta("id",run));
                            reply(id,true,null,0);break;
                        }
                        case "eval-part": {
                            String run=o.optString("runId","");
                            String chunk=o.optString("part","");
                            ScriptTransfer transfer=pendingScripts.get(run);
                            if(transfer==null){reply(id,false,"TRANSFER_NOT_FOUND",null);break;}
                            if(chunk.isEmpty()||chunk.length()>8000){
                                reply(id,false,"INVALID_PART",null);break;
                            }
                            if(transfer.content.length()+chunk.length()>MAX_SCRIPT_BYTES_IN_MEMORY){
                                pendingScripts.remove(run);
                                reply(id,false,"SCRIPT_RESOURCE_LIMIT",null);break;
                            }
                            transfer.content.append(chunk);
                            reply(id,true,null,transfer.content.length());break;
                        }
                        case "eval-finish": {
                            String run=o.optString("runId","");
                            ScriptTransfer transfer=pendingScripts.remove(run);
                            if(transfer==null || transfer.content.length()==0){
                                reply(id,false,"TRANSFER_NOT_FOUND",null);break;
                            }
                            final int scriptSlot=transfer.slot;
                            if(transfer.remote&&!remoteArmed){
                                reply(id,false,"REMOTE_DISABLED",null);break;
                            }
                            String currentUrl=browsers.get(scriptSlot).getUrl();
                            if(currentUrl==null || !currentUrl.equals(transfer.startUrl)){
                                reply(id,false,"SCRIPT_PAGE_CHANGED",null);break;
                            }
                            final String requestId=id, runId=run;
                            String source=transfer.content.toString();
                            telemetry.record("SCRIPT_ACCEPTED",scriptSlot,
                                    Telemetry.meta("id",run,"count",source.length()));
                            WebView view=browsers.get(scriptSlot);
                            String wrapped="(function(){try{return JSON.stringify({ok:true,result:("+source+")});}catch(e){return JSON.stringify({ok:false,reason:String(e&&e.message||e&&e.name||'ERROR')})}})()";
                            view.evaluateJavascript(wrapped, value -> {
                                boolean valid=value!=null && !"null".equals(value);
                                telemetry.record("SCRIPT_RESULT",scriptSlot,
                                        Telemetry.meta("id",runId,"ok",valid));
                                reply(requestId,valid,valid?null:"EVAL_NO_RESULT",
                                        valid?value:null);
                            });
                            break;
                        }
                        case "eval-stage": {
                            String run=o.optString("runId","");
                            String stage=o.optString("stage","");
                            String code=o.optString("code","");
                            int stageSlot=o.optInt("slot",-1);
                            if(!run.matches("[a-zA-Z0-9_-]{8,80}") ||
                                    !stage.matches("[A-Z][A-Z0-9_]{1,60}") ||
                                    code.length()>100 || stageSlot<0 || stageSlot>=browsers.size()){
                                reply(id,false,"INVALID_SCRIPT_STAGE",null);break;
                            }
                            telemetry.record("SCRIPT_STAGE",stageSlot,
                                    Telemetry.meta("id",run,"phase",stage,"code",code));
                            reply(id,true,null,null);break;
                        }
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
        @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
            return slot==-2 && request.isForMainFrame() && !isChromeUrl(request.getUrl().toString());
        }
        @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon) {
            if(slot==-2){chromeFailed=false;showChromeFallback(false);}
            telemetry.record("PAGE_START",slot,Telemetry.meta("host",hostOf(url)));
        }
        @Override public void onPageFinished(WebView view,String url) {
            telemetry.record("PAGE_FINISH",slot,Telemetry.meta("host",hostOf(url)));
            if(!isDashboard && slot>=0 && slot<browsers.size() && browsers.get(slot)==view && isHttpsUrl(url)) {
                state.edit().putString("browser_url_"+slot,url).apply();
            }
            if(slot==-2){showChromeFallback(chromeFailed);if(!chromeFailed)telemetry.record("CHROME_READY",-2,null);}
            postStatus();
        }
        @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) {
            if(request.isForMainFrame()){
                telemetry.record("WEBVIEW_ERROR",slot,Telemetry.meta("host",hostOf(request.getUrl().toString()),"code",error.getErrorCode()));
                if(slot==-2){chromeFailed=true;showChromeFallback(true);}
            }
        }
        @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response) {
            if(request.isForMainFrame()){
                telemetry.record("HTTP_ERROR",slot,Telemetry.meta("host",hostOf(request.getUrl().toString()),"code",response.getStatusCode()));
                if(slot==-2 && response.getStatusCode()>=400){chromeFailed=true;showChromeFallback(true);}
            }
        }
        @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error) {
            handler.cancel();
            telemetry.record("TLS_ERROR",slot,Telemetry.meta("code",error.getPrimaryError()));
            if(slot==-2){chromeFailed=true;showChromeFallback(true);}
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

    private void postPermissionsUpdated() {
        if(dashboard!=null && dashboardOrigin()){
            dashboard.evaluateJavascript("window.onDexaPermissionsUpdated&&window.onDexaPermissionsUpdated()",null);
        }
        postStatus();
    }

    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(code,permissions,results);
        if(permissionGateway!=null && permissionGateway.onPermissionResult(code,permissions,results)){
            postPermissionsUpdated();
            return;
        }
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

    @Override protected void onActivityResult(int code,int resultCode,android.content.Intent data) {
        super.onActivityResult(code,resultCode,data);
        if(permissionGateway!=null && permissionGateway.onActivityResult(code,resultCode,data)){
            postPermissionsUpdated();
        }
    }
    @Override protected void onResume() {
        super.onResume();
        if(telemetry!=null)telemetry.record("ACTIVITY_RESUME",activeSlot,null);
        if(dashboard!=null)postPermissionsUpdated();
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
