from pathlib import Path

service = Path('app/src/main/java/com/najme/perplexityprobe/PersianKeyboardService.java')
manifest = Path('app/src/main/AndroidManifest.xml')
gradle_file = Path('app/build.gradle')
s = service.read_text()
m = manifest.read_text()
g = gradle_file.read_text()


def rep(text, old, new, label):
    if old not in text:
        raise SystemExit(f'v1.47 patch: missing pattern: {label}')
    return text.replace(old, new, 1)


def replace_region(text, start_marker, end_marker, replacement, label):
    start = text.find(start_marker)
    end = text.find(end_marker, start + len(start_marker)) if start >= 0 else -1
    if start < 0 or end < 0:
        raise SystemExit(f'v1.47 patch: missing region: {label}')
    return text[:start] + replacement + text[end:]


# v1.47 addresses two current device blockers:
# 1) temporary microphone/network disruption must not destroy a healthy Soniox
#    session or force automatic Perplexity WebView reload/recreation;
# 2) host-created caret/range drift must self-heal while IME ownership is still
#    proved, including the v1.46 device state len=109 sel=106 owned=0:106.
# Human Perplexity/Cloudflare verification remains user-attended.

if 'android.permission.ACCESS_NETWORK_STATE' not in m:
    m = rep(
        m,
        '    <uses-permission android:name="android.permission.INTERNET" />\n',
        '    <uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n',
        'network-state permission',
    )

s = rep(
    s,
    '    private volatile int microphoneSuspendEpoch;\n',
    '    private volatile int microphoneSuspendEpoch;\n'
    '    private volatile int speechKeepaliveEpoch;\n'
    '    private boolean credentialRouteWaitScheduled;\n'
    '    private boolean warmCredentialRetryScheduled;\n',
    'v1.47 resilience state',
)

# Never create/navigate the hidden Perplexity broker while the user's VPN route is
# absent. This prevents a transient recovery from replacing a good session with the
# provider block page. Fail open only if Android cannot expose network capabilities.
ensure = r'''    private boolean perplexityRouteReady(){
        try{
            android.net.ConnectivityManager cm=(android.net.ConnectivityManager)
                    getSystemService(Context.CONNECTIVITY_SERVICE);
            if(cm==null)return true;
            android.net.Network n=cm.getActiveNetwork();
            if(n==null)return false;
            android.net.NetworkCapabilities caps=cm.getNetworkCapabilities(n);
            if(caps==null)return false;
            return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    &&caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN);
        }catch(Exception ignored){
            return true;
        }
    }

    private void scheduleCredentialRouteRetry(){
        if(credentialRouteWaitScheduled)return;
        credentialRouteWaitScheduled=true;
        main.postDelayed(()->{
            credentialRouteWaitScheduled=false;
            if(running||auth==null)ensureCredentialWebView();
        },2500L);
    }

    private void ensureCredentialWebView(){
        if(Looper.myLooper()!=Looper.getMainLooper()){
            main.post(this::ensureCredentialWebView);
            return;
        }
        if(auth!=null)return;
        if(!perplexityRouteReady()){
            if(running)setStatus(persian?"برای بازیابی اتصال، VPN را روشن نگه دارید…":"Keep VPN on for connection recovery…");
            if(running)scheduleCredentialRouteRetry();
            return;
        }
        credentialRouteWaitScheduled=false;
        brokerPageLoaded=false;
        pageReady=false;
        auth=new WebView(this);
        auth.setAlpha(0.01f);
        configureWebView();
        auth.loadUrl(START_URL);
    }

'''
s = replace_region(
    s,
    '    private void ensureCredentialWebView(){',
    '    private void clearWarmCredential(){',
    ensure,
    'VPN-gated credential WebView creation',
)

prefetch = r'''    private void scheduleWarmCredentialRetry(){
        if(warmCredentialRetryScheduled||warmCredentialUsable())return;
        warmCredentialRetryScheduled=true;
        long delay=Math.min(10000L,1500L+1500L*Math.max(1,warmCredentialFailureCount));
        main.postDelayed(()->{
            warmCredentialRetryScheduled=false;
            if(!warmCredentialUsable())prefetchWarmCredential();
        },delay);
    }

    private void prefetchWarmCredential(){
        if(Looper.myLooper()!=Looper.getMainLooper()){
            main.post(this::prefetchWarmCredential);
            return;
        }
        ensureCredentialWebView();
        if(auth==null||!brokerPageLoaded||warmCredentialFetchInFlight||warmCredentialUsable())return;
        warmCredentialFetchInFlight=true;
        final long requestId=++credentialRequestCounter;
        warmCredentialRequestId=requestId;
        String js=FETCH_CREDENTIAL_JS
                .replace("__VOICE_RUN__","0")
                .replace("__CRED_REQ__",Long.toString(requestId));
        try{auth.evaluateJavascript(js,null);}
        catch(Exception e){
            warmCredentialFetchInFlight=false;
            pageReady=false;
            warmCredentialFailureCount++;
            scheduleWarmCredentialRetry();
        }
        main.postDelayed(()->{
            if(!warmCredentialFetchInFlight||requestId!=warmCredentialRequestId)return;
            warmCredentialFetchInFlight=false;
            pageReady=false;
            warmCredentialFailureCount++;
            scheduleWarmCredentialRetry();
        },6500L);
    }

'''
s = replace_region(
    s,
    '    private void prefetchWarmCredential(){',
    '    public static void notifyPerplexitySessionChanged(){',
    prefetch,
    'non-destructive warm credential retries',
)

# Recreate only when genuinely required (renderer death or explicit visible-session
# change), and only once the VPN route is present. Credential/network timeouts no
# longer call this method in v1.47.
recreate = r'''    private void recreateCredentialWebView(String reason){
        if(Looper.myLooper()!=Looper.getMainLooper()){
            main.post(()->recreateCredentialWebView(reason));
            return;
        }
        if(!perplexityRouteReady()){
            setStatus(persian?"VPN را روشن کنید؛ نشست Perplexity حفظ شده است…":"Turn on VPN; Perplexity session is being preserved…");
            scheduleCredentialRouteRetry();
            return;
        }
        brokerPageLoaded=false;
        pageReady=false;
        warmCredentialFetchInFlight=false;
        clearWarmCredential();
        credentialAttempt=0;
        try{CookieManager.getInstance().flush();}catch(Exception ignored){}

        WebView old=auth;
        auth=null;
        if(old!=null){
            try{old.stopLoading();}catch(Exception ignored){}
            try{old.removeJavascriptInterface("AndroidKeyboard");}catch(Exception ignored){}
            try{
                android.view.ViewParent parent=old.getParent();
                if(parent instanceof ViewGroup)((ViewGroup)parent).removeView(old);
            }catch(Exception ignored){}
            try{old.destroy();}catch(Exception ignored){}
        }
        ensureCredentialWebView();
        if(running&&awaitingCredential){
            retryAfterPageLoad=true;
            setStatus(persian?"در حال بازیابی نشست Perplexity…":"Recovering Perplexity session…");
        }else if(!running){
            setStatus(persian?"در حال بررسی نشست Perplexity…":"Checking Perplexity session…");
        }
    }

'''
s = replace_region(
    s,
    '    private void recreateCredentialWebView(String reason){',
    '    private void armCredentialWatchdog(){',
    recreate,
    'route-safe explicit broker recreation',
)

watchdog = r'''    private void armCredentialWatchdog(){
        final long runId=activeVoiceRunId;
        final int watchdog=++credentialWatchdogEpoch;
        main.postDelayed(()->{
            if(watchdog!=credentialWatchdogEpoch||!voiceRunActive(runId)||completed||stopRequested||!awaitingCredential)return;
            credentialWebViewResets++;
            if(!perplexityRouteReady()){
                setStatus(persian?"اتصال منتظر VPN است…":"Connection recovery is waiting for VPN…");
                scheduleCredentialRouteRetry();
                main.postDelayed(this::armCredentialWatchdog,2500L);
                return;
            }
            ensureCredentialWebView();
            if(auth!=null&&brokerPageLoaded){
                setStatus(persian?"اتصال موقتاً قطع شده — تلاش مجدد…":"Connection interrupted — retrying…");
                requestCredential(runId);
            }else{
                retryAfterPageLoad=true;
            }
            if(voiceRunActive(runId)&&awaitingCredential)armCredentialWatchdog();
        },6500L);
    }

'''
s = replace_region(
    s,
    '    private void armCredentialWatchdog(){',
    '    private long bridgeLong(String value){',
    watchdog,
    'non-destructive credential watchdog',
)

# Credential fetch failures are transport/network events until proven otherwise.
# Preserve the loaded WebView and cookies; retry JS against the same broker page.
cred_error = r'''        @JavascriptInterface public void credentialError(String error,String runValue,String requestValue){
            final long runId=bridgeLong(runValue);final long requestId=bridgeLong(requestValue);
            main.post(()->{
                if(runId==0L){
                    if(requestId!=warmCredentialRequestId)return;
                    warmCredentialFetchInFlight=false;
                    pageReady=false;
                    clearWarmCredential();
                    lastCredentialError=safeCredentialError(error);
                    warmCredentialFailureCount++;
                    scheduleWarmCredentialRetry();
                    return;
                }
                if(!voiceRunActive(runId)||!awaitingCredential||requestId!=activeCredentialRequestId)return;
                pageReady=false;
                lastCredentialError=safeCredentialError(error);
                credentialWebViewResets++;
                final int retryEpoch=++credentialWatchdogEpoch;
                long delay=Math.min(8000L,1000L+1000L*Math.min(7,credentialWebViewResets));
                if(credentialWebViewResets>=4)
                    setStatus(persian?"اتصال در حال بازیابی است؛ اگر ادامه داشت برنامه را برای تأیید باز کنید":"Recovering connection; open app for verification only if this persists");
                else
                    setStatus(persian?"اتصال موقتاً قطع شده — تلاش مجدد…":"Connection interrupted — retrying…");
                main.postDelayed(()->{
                    if(retryEpoch!=credentialWatchdogEpoch||!voiceRunActive(runId)||completed||stopRequested||!awaitingCredential)return;
                    ensureCredentialWebView();
                    if(auth!=null&&brokerPageLoaded){
                        retryAfterPageLoad=false;
                        requestCredential(runId);
                    }else{
                        retryAfterPageLoad=true;
                    }
                    if(voiceRunActive(runId)&&awaitingCredential)armCredentialWatchdog();
                },delay);
            });
        }
'''
s = replace_region(
    s,
    '        @JavascriptInterface public void credentialError(',
    '    }\n\n    @Override public void onDestroy()',
    cred_error,
    'non-destructive credential error handling',
)

# A socket retry consumes a warm credential before touching Perplexity. A failed
# warm reconnect is allowed to re-enter recovery instead of being suppressed by a
# stale speechRecovering=true flag. If microphone capture is currently preempted,
# defer all credential work until capture returns.
recovery = r'''    private void recoverSpeechTransport(String reason){recoverSpeechTransport(reason,activeVoiceRunId);}

    private void recoverSpeechTransport(String reason,long runId){
        if(!voiceRunActive(runId)||completed||stopRequested)return;
        synchronized(audioLock){
            if(!voiceRunActive(runId))return;
            if(speechRecovering&&awaitingCredential)return;
            speechRecovering=true;
            sonioxReady=false;
            finishSent=false;
            finishAckEpoch++;
        }
        WebSocket old=webSocket;
        webSocket=null;
        if(old!=null)try{old.cancel();}catch(Exception ignored){}
        synchronized(textLock){
            if(partialTranscript!=null&&!partialTranscript.isEmpty()){
                finalTranscript.append(partialTranscript);
                partialTranscript="";
            }
            finalTokenIds.clear();
        }
        publish(false,runId);
        if(!voiceRunActive(runId))return;

        if(microphoneSilenced){
            awaitingCredential=false;
            activeCredentialRequestId=0L;
            credentialWatchdogEpoch++;
            diag("V147 TRANSPORT_RECOVERY_DEFER_MIC run="+runId+" pkg="+diagPackage());
            setStatus(persian?"میکروفون موقتاً در اختیار برنامهٔ دیگری است…":"Microphone temporarily in use…");
            return;
        }

        awaitingCredential=true;
        credentialAttempt=0;
        retryAfterPageLoad=false;
        lastCredentialError="";
        final int epoch=++speechRecoveryEpoch;
        main.post(()->{
            if(!voiceRunActive(runId)||completed||stopRequested||epoch!=speechRecoveryEpoch)return;
            setStatus(persian?"در حال اتصال مجدد…":"Reconnecting speech…");
            String warm=consumeWarmCredential();
            if(warm!=null){
                awaitingCredential=false;
                pageReady=true;
                speechRecovering=false;
                startSoniox(warm,runId);
                main.postDelayed(PersianKeyboardService.this::prefetchWarmCredential,500L);
                return;
            }
            ensureCredentialWebView();
            if(auth!=null&&brokerPageLoaded){
                requestCredential(runId);
                armCredentialWatchdog();
            }else{
                retryAfterPageLoad=true;
                armCredentialWatchdog();
            }
        });
    }

'''
s = replace_region(
    s,
    '    private boolean recoverableSonioxError(JSONObject o){',
    '    private void requestStop(){',
    # Keep the recoverable-error classifier from the existing source, then replace
    # only the recovery methods that follow it.
    s[s.find('    private boolean recoverableSonioxError(JSONObject o){'):s.find('    private void recoverSpeechTransport(String reason){')] + recovery,
    'warm-first transport recovery',
)

# Keep a healthy Soniox socket alive while Android temporarily silences AudioRecord.
# Soniox STT documents {"type":"keepalive"}; no PCM is forwarded while silenced.
mic_methods = r'''    private void stopSpeechKeepalive(){speechKeepaliveEpoch++;}

    private void armSpeechKeepalive(long runId){
        final int epoch=++speechKeepaliveEpoch;
        sendSpeechKeepalive(runId,epoch);
    }

    private void sendSpeechKeepalive(long runId,int epoch){
        if(epoch!=speechKeepaliveEpoch||!voiceRunActive(runId)||!microphoneSilenced)return;
        WebSocket ws=webSocket;
        if(ws==null||!sonioxReady)return;
        boolean ok=false;
        try{ok=ws.send("{\"type\":\"keepalive\"}");}catch(Exception ignored){}
        if(!ok){
            synchronized(audioLock){
                if(webSocket==ws){webSocket=null;sonioxReady=false;speechRecovering=true;}
            }
            try{ws.cancel();}catch(Exception ignored){}
            diag("V147 KEEPALIVE_SEND_FAILED run="+runId+" pkg="+diagPackage());
            return;
        }
        main.postDelayed(()->sendSpeechKeepalive(runId,epoch),8000L);
    }

    private void checkMicrophoneRecovery(long runId,int epoch){
        if(android.os.Build.VERSION.SDK_INT<29||epoch!=microphoneSuspendEpoch
                ||!microphoneSilenced||!voiceRunActive(runId))return;
        AudioRecord recorder=audioRecord;
        if(recorder!=null){
            try{
                android.media.AudioRecordingConfiguration config=recorder.getActiveRecordingConfiguration();
                if(config!=null&&!config.isClientSilenced()){
                    handleMicrophoneSilenced(false);
                    return;
                }
            }catch(Exception ignored){}
        }
        main.postDelayed(()->checkMicrophoneRecovery(runId,epoch),750L);
    }

    private void handleMicrophoneSilenced(boolean silenced){
        if(microphoneSilenced==silenced)return;
        microphoneSilenced=silenced;
        final int suspendEpoch=++microphoneSuspendEpoch;
        final long runId=activeVoiceRunId;
        diag("MIC silenced="+silenced+" running="+running+" run="+runId);
        if(!voiceRunActive(runId))return;
        if(silenced){
            awaitingCredential=false;
            activeCredentialRequestId=0L;
            credentialWatchdogEpoch++;
            if(webSocket!=null&&sonioxReady){
                diag("V147 MIC_SUSPEND_KEEP_SOCKET run="+runId+" pkg="+diagPackage());
                armSpeechKeepalive(runId);
            }
            setStatus(persian?"میکروفون موقتاً در اختیار برنامهٔ دیگری است…":"Microphone temporarily in use…");
            main.postDelayed(()->checkMicrophoneRecovery(runId,suspendEpoch),750L);
            return;
        }

        stopSpeechKeepalive();
        if(!voiceRunActive(runId)||completed||stopRequested)return;
        if(webSocket!=null&&sonioxReady){
            speechRecovering=false;
            diag("V147 MIC_RESUME_SAME_SOCKET run="+runId+" pkg="+diagPackage());
            setStatus(listeningText());
            return;
        }
        diag("V147 MIC_RESUME_RECOVER_SOCKET run="+runId+" pkg="+diagPackage());
        speechRecovering=false;
        awaitingCredential=false;
        recoverSpeechTransport("Microphone restored",runId);
    }

'''
s = replace_region(
    s,
    '    private void checkMicrophoneRecovery(long runId,int epoch){',
    '    private final android.media.AudioManager.AudioRecordingCallback audioRecordingCallback=',
    mic_methods,
    'keep-socket microphone preemption recovery',
)

# v1.45 handled only exact end-1. Generalize the same strict proof to a tiny
# 1..4 UTF-16 host lag while keeping the short IME-owned lease and no-newer-touch
# gate. This still never reanchors a genuine user caret move.
caret_helpers = r'''    private boolean voicePrefixProvesTransientCaretLag(
            InputConnection ic,VoiceEditorWindow current){
        if(ic==null||current==null)return false;
        int expected=voiceProgrammaticCaretLeaseEnd;
        if(expected<=0||expected!=voiceExpectedSelectionStart||expected!=voiceExpectedSelectionEnd)return false;
        if(voiceOwnedEnd!=expected||current.selectionStart!=current.selectionEnd)return false;
        int lag=expected-current.selectionStart;
        if(lag<=0||lag>4)return false;
        long now=android.os.SystemClock.uptimeMillis();
        if(now>voiceProgrammaticCaretLeaseUntilUptime)return false;
        if(SendAccessibilityService.userTouchGeneration()>voiceProgrammaticCaretTouchGeneration)return false;

        String published=voicePublishedText==null?"":voicePublishedText;
        int prefixLen=published.length()-lag;
        if(prefixLen<=0)return false;
        int guardLen=Math.min(96,prefixLen);
        String guard=published.substring(prefixLen-guardLen,prefixLen);
        try{
            CharSequence beforeCs=ic.getTextBeforeCursor(guardLen,0);
            if(beforeCs==null)return false;
            String before=beforeCs.toString();
            if(before.endsWith(guard))return true;
            String normalizedGuard=normalizeVoiceOwnedText(guard);
            return !normalizedGuard.isEmpty()
                    &&normalizeVoiceOwnedText(before).endsWith(normalizedGuard);
        }catch(Exception ignored){
            return false;
        }
    }

    private boolean healTransientVoiceCaretLag(
            InputConnection ic,VoiceEditorWindow current,long runId){
        if(!voiceRunActive(runId)||!voicePrefixProvesTransientCaretLag(ic,current))return false;
        int expected=voiceProgrammaticCaretLeaseEnd;
        int lag=expected-current.selectionStart;
        long now=android.os.SystemClock.uptimeMillis();
        programmaticSelectionEditDepth++;
        try{
            if(!ic.setSelection(expected,expected))return false;
            voiceSelectionFollowsOwnedRange=true;
            voiceExpectedSelectionStart=expected;
            voiceExpectedSelectionEnd=expected;
            rememberProgrammaticSelection();
            voiceProgrammaticCaretLeaseUntilUptime=now+350L;
            diag("V147 CARET_LAG_HEAL lag="+lag+" expected="+expected+" run="+runId+
                    " pkg="+diagPackage());
            return true;
        }catch(Exception ignored){
            return false;
        }finally{
            programmaticSelectionEditDepth=Math.max(0,programmaticSelectionEditDepth-1);
        }
    }

'''
marker = '    private boolean voicePrefixProvesTransientEndMinusOne('
if marker not in s:
    raise SystemExit('v1.47 patch: v1.45 caret helper marker missing')
s = s.replace(marker, caret_helpers + marker, 1)
s = rep(
    s,
    'if(healTransientVoiceEndMinusOne(ic,current,runId))return;',
    'if(healTransientVoiceCaretLag(ic,current,runId))return;',
    'selection callback generalized caret lag recovery',
)
s = rep(
    s,
    'boolean repairedEndMinusOne=healTransientVoiceEndMinusOne(ic,window,runId);',
    'boolean repairedEndMinusOne=healTransientVoiceCaretLag(ic,window,runId);',
    'publisher generalized caret lag recovery',
)

# v1.46 required locateVoiceOwnedRegion() before it could delete the stale tail.
# The current real-device evidence proves that function can be null even when the
# entire field belongs to this voice run and the caret exactly matches expected.
# In that strongest ownership case, recover directly from full-field ownership.
whole_field = r'''    private boolean recoverWholeFieldVoiceDrift(
            InputConnection ic,VoiceEditorWindow window,String desired,String partial,
            int finalChars,boolean finish,long runId){
        if(!voiceRunActive(runId)||ic==null||window==null||desired==null)return false;
        if(!voiceBoundaryOwnsWholeField||voiceOwnedStart!=0||window.absoluteStart!=0)return false;
        if(!voiceSelectionFollowsOwnedRange||window.selectionStart!=window.selectionEnd)return false;
        int expected=voiceExpectedSelectionEnd;
        if(expected<0||window.selectionStart!=expected||voiceExpectedSelectionStart!=expected
                ||voiceOwnedEnd!=expected||expected!=desired.length())return false;
        long now=android.os.SystemClock.uptimeMillis();
        if(now>voiceProgrammaticCaretLeaseUntilUptime)return false;
        if(SendAccessibilityService.userTouchGeneration()>voiceProgrammaticCaretTouchGeneration)return false;
        int retained=window.text.length()-expected;
        if(retained<=0||retained>32)return false;

        boolean batch=false;boolean ok=false;
        programmaticSelectionEditDepth++;
        try{
            batch=ic.beginBatchEdit();
            if(voiceDesiredSuffixMatchesBeforeCursor(ic,desired,0,expected)){
                if(!ic.deleteSurroundingText(0,retained))return false;
                if(!ic.setSelection(expected,expected))return false;
                diag("V147 WHOLE_FIELD_STALE_TAIL_DELETE retained="+retained+
                        " expected="+expected+" run="+runId+" pkg="+diagPackage());
            }else{
                if(!voiceRegionLooksLikeHostRewrite(window.text,desired))return false;
                if(!ic.setSelection(0,window.text.length()))return false;
                if(!ic.commitText(desired,1))return false;
                expected=desired.length();
                if(!ic.setSelection(expected,expected))return false;
                diag("V147 WHOLE_FIELD_CANONICALIZE excess="+retained+
                        " newEnd="+expected+" run="+runId+" pkg="+diagPackage());
            }
            voicePublishedText=desired;
            voiceOwnedStart=0;
            voiceOwnedEnd=expected;
            voiceSelectionFollowsOwnedRange=true;
            voiceExpectedSelectionStart=expected;
            voiceExpectedSelectionEnd=expected;
            voiceProgrammaticCaretLeaseEnd=expected;
            voiceProgrammaticCaretLeaseUntilUptime=now+1500L;
            voiceProgrammaticCaretTouchGeneration=SendAccessibilityService.userTouchGeneration();
            committedFinalChars=finalChars;
            livePartialTail=finish?"":partial;
            hasComposingTail=false;
            voiceExternalClearStopArmed=expected>0;
            rememberProgrammaticSelection();
            ok=true;
            return true;
        }catch(Exception ignored){
            return false;
        }finally{
            if(batch)try{ic.endBatchEdit();}catch(Exception ignored){}
            programmaticSelectionEditDepth=Math.max(0,programmaticSelectionEditDepth-1);
            if(ok)clearVoicePublicationPaused(runId);
        }
    }

'''
recover_marker = '    private boolean recoverHostRetainedVoiceTail('
if recover_marker not in s:
    raise SystemExit('v1.47 patch: v1.46 stale-tail helper marker missing')
s = s.replace(recover_marker, whole_field + recover_marker, 1)
needle = '''        if(SendAccessibilityService.userTouchGeneration()>voiceProgrammaticCaretTouchGeneration)return false;\n\n        int[] boundary=locateVoiceOwnedRegion(window);\n'''
replacement = '''        if(SendAccessibilityService.userTouchGeneration()>voiceProgrammaticCaretTouchGeneration)return false;\n        if(recoverWholeFieldVoiceDrift(ic,window,desired,partial,finalChars,finish,runId))return true;\n\n        int[] boundary=locateVoiceOwnedRegion(window);\n'''
s = rep(s, needle, replacement, 'whole-field recovery before boundary lookup')

s = rep(
    s,
    'diagCurrentEditor("V146 PUB_PAUSE region-null");',
    'diagCurrentEditor("V147 PUB_PAUSE region-null");',
    'v1.47 publication diagnostic frontier',
)

if 'versionCode 56' not in g or "versionName '1.46'" not in g:
    raise SystemExit('v1.47 patch: expected v1.46 Gradle markers missing')
g = g.replace('versionCode 56','versionCode 57',1)
g = g.replace("versionName '1.46'","versionName '1.47'",1)

text='\n'.join([s,m,g])
required=[
    'android.permission.ACCESS_NETWORK_STATE',
    'private boolean perplexityRouteReady()',
    'TRANSPORT_VPN',
    'private void armSpeechKeepalive(long runId)',
    '{\\"type\\":\\"keepalive\\"}',
    'V147 MIC_SUSPEND_KEEP_SOCKET',
    'V147 MIC_RESUME_SAME_SOCKET',
    'V147 TRANSPORT_RECOVERY_DEFER_MIC',
    'private boolean healTransientVoiceCaretLag(',
    'lag>4',
    'V147 CARET_LAG_HEAL',
    'private boolean recoverWholeFieldVoiceDrift(',
    'V147 WHOLE_FIELD_STALE_TAIL_DELETE',
    'V147 WHOLE_FIELD_CANONICALIZE',
    'diagCurrentEditor("V147 PUB_PAUSE region-null");',
    'versionCode 57',
    "versionName '1.47'",
]
for needle in required:
    if needle not in text:
        raise SystemExit(f'v1.47 patch: required invariant missing: {needle}')

for forbidden in [
    'recreateCredentialWebView("credential callback timeout")',
    'recreateCredentialWebView("warm credential timeout")',
    'diagCurrentEditor("V146 PUB_PAUSE region-null");',
    'versionCode 56',
    "versionName '1.46'",
]:
    if forbidden in text:
        raise SystemExit(f'v1.47 patch: forbidden prior frontier remains: {forbidden}')

service.write_text(s)
manifest.write_text(m)
gradle_file.write_text(g)
print('Applied Persian keyboard v1.47 connection + caret resilience patch')
