package dev.capabilityfabric.personalagent;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public class WakeActivity extends Activity {
    public static final String EXTRA_DICTATION_MODE="dev.capabilityfabric.personalagent.DICTATION";
    private boolean dictationMode;
    private boolean autoStartPending;
    private TextView capturedCommand;
    private static final int REQ_MIC = 41;
    private static final String START_URL = "https://www.perplexity.ai/";
    private static final String SONIOX_WS = "wss://stt-rt.soniox.com/transcribe-websocket";
    private static final int SAMPLE_RATE = 16000;
    private static final int AUDIO_CHUNK = 3200;
    private static final int MAX_PENDING_BYTES = SAMPLE_RATE * 2 * 12;
    private static final long CREDENTIAL_TIMEOUT_MS = 18000L;
    private static final int[] DELAYS_MS = {0, 800, 1200, 1500, 2000, 2500};
    private static final String[] DELAY_LABELS = {"0 s", "0.8 s", "1.2 s", "1.5 s", "2.0 s", "2.5 s"};
    private static final String PREFS = "wake_probe";
    private static final String PREF_WAKE = "wake_phrase";
    private static final String PREF_WAKE_ALT = "wake_phrase_alias_2";
    private static final String PREF_DELAY = "silence_delay_ms";
    private static final String PREF_WAKE_DELAY = "wake_silence_delay_ms";
    private static final String PREF_COMMAND_DELAY = "command_silence_delay_ms";
    private static final String PREF_LOCKED = "keep_listening_locked";
    private static final String MOBILE_BROWSER_UA =
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    private final Object audioLock = new Object();
    private final Object textLock = new Object();
    private final ArrayDeque<byte[]> pendingAudio = new ArrayDeque<>();
    private final Set<String> finalTokenIds = new HashSet<>();
    private final StringBuilder heldFinal = new StringBuilder();

    private SharedPreferences prefs;
    private EditText wakeField;
    private EditText wakeAliasField;
    private Spinner wakeDelaySpinner;
    private Spinner commandDelaySpinner;
    private CheckBox lockedModeBox;
    private TextView lastChunk;
    private TextView status;
    private Button startStop;
    private WebView auth;
    private ToneGenerator tone;

    private volatile boolean pageReady;
    private volatile boolean running;
    private volatile boolean stopRequested;
    private volatile boolean awaitingCredential;
    private volatile boolean sonioxReady;
    private volatile boolean audioDone;
    private volatile boolean finishSent;
    private volatile long activeEpoch;

    private enum ListeningPhase { WAKE, COMMAND }

    private long epochCounter;
    private long lastSpeechAt;
    private int wakeDelayMs = 0;
    private int commandDelayMs = 1500;
    private ListeningPhase listeningPhase = ListeningPhase.WAKE;
    private int pendingBytes;
    private int credentialAttempt;
    private boolean retryAfterPageLoad;
    private volatile boolean activityResumed;
    private AudioRecord audioRecord;
    private WebSocket webSocket;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(true);

        dictationMode=getIntent().getBooleanExtra(EXTRA_DICTATION_MODE,false);
        autoStartPending=dictationMode;
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        int legacyDelayMs = prefs.getInt(PREF_DELAY, 0);
        wakeDelayMs = prefs.getInt(PREF_WAKE_DELAY, legacyDelayMs);
        commandDelayMs = prefs.getInt(PREF_COMMAND_DELAY, 1500);
        tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90);

        buildUi();
        configureAuthWebView();
        auth.loadUrl(START_URL);
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setBackgroundColor(0xFFF4F5F7);
        applySafeInsets(scroll);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(18), dp(18), dp(18));
        root.setBackgroundColor(0xFFF4F5F7);

        TextView title = new TextView(this);
        title.setText(dictationMode ? "Agent OS · Speak (Soniox)" : "Agent OS · Wake Handshake");
        title.setTextSize(24f);
        title.setTextColor(0xFF202124);
        title.setGravity(Gravity.START);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText(dictationMode
                ? "Perplexity/Soniox dictation: speak normally, then pause to save the command locally."
                : "Perplexity/Soniox wake engine. Opt-in screen-off listening; continuous mic+network use.");
        subtitle.setTextSize(12f);
        subtitle.setTextColor(0xFF6B7280);
        subtitle.setPadding(0, dp(3), 0, dp(16));
        root.addView(subtitle);

        TextView wakeLabel = label("Wake phrase 1");
        root.addView(wakeLabel);

        wakeField = new EditText(this);
        wakeField.setSingleLine(true);
        wakeField.setText(prefs.getString(PREF_WAKE, "خط باز"));
        wakeField.setTextSize(18f);
        wakeField.setPadding(dp(12), dp(10), dp(12), dp(10));
        wakeField.setBackground(roundRect(Color.WHITE, 0xFFD1D5DB, 1, 12));
        root.addView(wakeField, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if(dictationMode){wakeField.setVisibility(View.GONE);wakeLabel.setVisibility(View.GONE);}
        wakeField.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) saveWakePhrases();
        });

        TextView wakeAliasLabel = label("Wake phrase 2 (optional)");
        wakeAliasLabel.setPadding(0, dp(10), 0, dp(6));
        root.addView(wakeAliasLabel);

        wakeAliasField = new EditText(this);
        wakeAliasField.setSingleLine(true);
        wakeAliasField.setText(prefs.getString(PREF_WAKE_ALT, ""));
        wakeAliasField.setTextSize(18f);
        wakeAliasField.setPadding(dp(12), dp(10), dp(12), dp(10));
        wakeAliasField.setBackground(roundRect(Color.WHITE, 0xFFD1D5DB, 1, 12));
        root.addView(wakeAliasField, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if(dictationMode){wakeAliasField.setVisibility(View.GONE);wakeAliasLabel.setVisibility(View.GONE);}
        wakeAliasField.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) saveWakePhrases();
        });

        LinearLayout wakeDelayRow = new LinearLayout(this);
        wakeDelayRow.setOrientation(LinearLayout.HORIZONTAL);
        wakeDelayRow.setGravity(Gravity.CENTER_VERTICAL);
        wakeDelayRow.setPadding(0, dp(14), 0, dp(6));
        TextView wakeDelayLabel = label("Wake delay");
        wakeDelayRow.addView(wakeDelayLabel, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        wakeDelaySpinner = new Spinner(this);
        ArrayAdapter<String> wakeDelayAdapter = new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_dropdown_item, DELAY_LABELS);
        wakeDelaySpinner.setAdapter(wakeDelayAdapter);
        int wakeSelected = delayIndexFor(wakeDelayMs, 0);
        wakeDelaySpinner.setSelection(wakeSelected);
        wakeDelaySpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view,
                                                 int position, long id) {
                wakeDelayMs = DELAYS_MS[position];
                prefs.edit().putInt(PREF_WAKE_DELAY, wakeDelayMs).apply();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        wakeDelayRow.addView(wakeDelaySpinner);
        root.addView(wakeDelayRow);
        if(dictationMode) wakeDelayRow.setVisibility(View.GONE);

        LinearLayout commandDelayRow = new LinearLayout(this);
        commandDelayRow.setOrientation(LinearLayout.HORIZONTAL);
        commandDelayRow.setGravity(Gravity.CENTER_VERTICAL);
        commandDelayRow.setPadding(0, 0, 0, dp(12));
        TextView commandDelayLabel = label(dictationMode ? "Dictation silence delay" : "Command delay");
        commandDelayRow.addView(commandDelayLabel, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        commandDelaySpinner = new Spinner(this);
        ArrayAdapter<String> commandDelayAdapter = new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_dropdown_item, DELAY_LABELS);
        commandDelaySpinner.setAdapter(commandDelayAdapter);
        int commandSelected = delayIndexFor(commandDelayMs, 3);
        commandDelaySpinner.setSelection(commandSelected);
        commandDelaySpinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view,
                                                 int position, long id) {
                commandDelayMs = DELAYS_MS[position];
                prefs.edit().putInt(PREF_COMMAND_DELAY, commandDelayMs).apply();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        commandDelayRow.addView(commandDelaySpinner);
        root.addView(commandDelayRow);

        lockedModeBox = new CheckBox(this);
        lockedModeBox.setText("Keep listening when screen is locked");
        lockedModeBox.setTextSize(14f);
        lockedModeBox.setChecked(prefs.getBoolean(PREF_LOCKED, false));
        lockedModeBox.setOnCheckedChangeListener((buttonView, checked) -> {
            prefs.edit().putBoolean(PREF_LOCKED, checked).apply();
            if (running) {
                if (checked) startKeepAliveService();
                else stopKeepAliveService();
            }
        });
        root.addView(lockedModeBox);
        if(dictationMode) lockedModeBox.setVisibility(View.GONE);

        TextView lockedHint = new TextView(this);
        lockedHint.setText("When enabled, an active listening session keeps running after the phone locks. Switching to another app while the screen stays on still stops listening.");
        lockedHint.setTextSize(11f);
        lockedHint.setTextColor(0xFF6B7280);
        lockedHint.setPadding(dp(3), 0, dp(3), dp(10));
        root.addView(lockedHint);
        if(dictationMode) lockedHint.setVisibility(View.GONE);

        TextView outputLabel = label("Last emitted chunk");
        root.addView(outputLabel);

        lastChunk = new TextView(this);
        lastChunk.setText("—");
        lastChunk.setTextSize(22f);
        lastChunk.setTextColor(0xFF111827);
        lastChunk.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        lastChunk.setPadding(dp(16), dp(16), dp(16), dp(16));
        lastChunk.setMinHeight(dp(132));
        lastChunk.setBackground(roundRect(Color.WHITE, 0xFFCBD5E1, 1, 14));
        root.addView(lastChunk, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        capturedCommand=new TextView(this);
        capturedCommand.setText("Saved agent command: " + CommandInbox.latest(this));
        capturedCommand.setTextSize(14f);
        capturedCommand.setTextColor(0xFF27344B);
        capturedCommand.setPadding(0,dp(12),0,dp(8));
        root.addView(capturedCommand);

        Button returnToAgent=new Button(this);
        returnToAgent.setAllCaps(false);
        returnToAgent.setText(dictationMode ? "Cancel / Return to Agent OS" : "Return to Agent OS / review command");
        returnToAgent.setOnClickListener(v -> {
            if(running) stopImmediate(activeEpoch,"Stopped before leaving wake mode.");
            Intent i=new Intent(this,MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
            finish();
        });
        root.addView(returnToAgent);

        startStop = new Button(this);
        startStop.setText(dictationMode ? "Start dictating" : "Start listening");
        startStop.setAllCaps(false);
        startStop.setTextSize(17f);
        startStop.setOnClickListener(v -> {
            saveWakePhrases();
            if (running) requestStop();
            else beginStart();
        });
        LinearLayout.LayoutParams buttonLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        buttonLp.setMargins(0, dp(16), 0, 0);
        root.addView(startStop, buttonLp);

        Button setup = new Button(this);
        setup.setText("Open Perplexity session");
        setup.setAllCaps(false);
        setup.setOnClickListener(v -> startActivity(new Intent(this, WakeSetupActivity.class)));
        LinearLayout.LayoutParams setupLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        setupLp.setMargins(0, dp(8), 0, 0);
        root.addView(setup, setupLp);

        status = new TextView(this);
        status.setText("Loading Perplexity session…");
        status.setTextSize(12f);
        status.setTextColor(0xFF6B7280);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(12), 0, 0);
        root.addView(status);

        auth = new WebView(this);
        auth.setAlpha(0.01f);
        root.addView(auth, new LinearLayout.LayoutParams(1, 1));

        scroll.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
    }

    private void applySafeInsets(View view) {
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets safe = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = safe.left;
                top = safe.top;
                right = safe.right;
                bottom = safe.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        view.requestApplyInsets();
    }

    private int delayIndexFor(int delayMs, int fallback) {
        for (int i = 0; i < DELAYS_MS.length; i++) {
            if (DELAYS_MS[i] == delayMs) return i;
        }
        return fallback;
    }

    private TextView label(String text) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextSize(12f);
        v.setTextColor(0xFF4B5563);
        v.setPadding(0, 0, 0, dp(6));
        return v;
    }

    private GradientDrawable roundRect(int fill, int stroke, int strokeDp, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        g.setStroke(dp(strokeDp), stroke);
        return g;
    }

    private void saveWakePhrases() {
        if (wakeField == null || wakeAliasField == null) return;
        prefs.edit()
                .putString(PREF_WAKE, wakeField.getText().toString())
                .putString(PREF_WAKE_ALT, wakeAliasField.getText().toString())
                .apply();
    }

    private void beginStart() {
        if (Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        startVoice();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                                     int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC && grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startVoice();
        } else if (requestCode == REQ_MIC) {
            AgentTelemetry.note(this,dictationMode?"SPEAK_ERROR":"WAKE_ERROR",
              dictationMode?"SPEAK":"WAKE","ERROR","PERMISSION");
            setStatus("Microphone permission is required.");
        }
    }

    private void startVoice() {
        if (running) return;
        if (!pageReady) {
            AgentTelemetry.note(this,dictationMode?"SPEAK_ERROR":"WAKE_ERROR",
              dictationMode?"SPEAK":"WAKE","AUTH","AUTH");
            setStatus("Perplexity session is not ready. Open the session once, then return.");
            return;
        }

        long epoch = ++epochCounter;
        activeEpoch = epoch;
        running = true;
        stopRequested = false;
        awaitingCredential = true;
        sonioxReady = false;
        audioDone = false;
        finishSent = false;
        retryAfterPageLoad = false;
        credentialAttempt = 0;
        listeningPhase = ListeningPhase.WAKE;
        lastSpeechAt = SystemClock.uptimeMillis();

        synchronized (audioLock) {
            pendingAudio.clear();
            pendingBytes = 0;
        }
        synchronized (textLock) {
            heldFinal.setLength(0);
            finalTokenIds.clear();
        }

        startStop.setText("Stop");
        AgentTelemetry.note(this,dictationMode?"SPEAK_START":"WAKE_START",
          dictationMode?"SPEAK":"WAKE","LISTENING","NONE");
        setStatus("Listening for wake phrase…");
        if (keepListeningLocked()) startKeepAliveService();
        startAudioCapture(epoch);
        requestCredential(epoch);
        main.postDelayed(() -> {
            if (isActive(epoch) && awaitingCredential) {
                failSession(epoch, "Perplexity speech credential timed out.");
            }
        }, CREDENTIAL_TIMEOUT_MS);
    }

    private void requestCredential(long epoch) {
        if (!isActive(epoch) || !awaitingCredential || auth == null) return;
        credentialAttempt++;
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        auth.evaluateJavascript(FETCH_CREDENTIAL_JS, null);
    }

    private void requestStop() {
        if (!running) return;
        long epoch = activeEpoch;
        if (awaitingCredential && !sonioxReady) {
            stopImmediate(epoch, "Stopped.");
            return;
        }
        stopRequested = true;
        setStatus("Finalizing…");
        AudioRecord r = audioRecord;
        if (r != null) {
            try { r.stop(); } catch (Exception ignored) {}
        }
    }

    private boolean isActive(long epoch) {
        return running && activeEpoch == epoch;
    }

    private void startSoniox(String apiKey, long epoch) {
        if (!isActive(epoch)) return;
        try {
            JSONObject config = new JSONObject();
            config.put("api_key", apiKey);
            config.put("model", "stt-rt-v4");
            config.put("audio_format", "pcm_s16le");
            config.put("sample_rate", SAMPLE_RATE);
            config.put("num_channels", 1);
            config.put("enable_endpoint_detection", true);
            config.put("max_endpoint_delay_ms", 1000);
            JSONArray hints = new JSONArray();
            hints.put("fa");
            hints.put("en");
            config.put("language_hints", hints);

            http.newWebSocket(new Request.Builder().url(SONIOX_WS).build(),
                    new WebSocketListener() {
                        @Override public void onOpen(WebSocket ws, Response response) {
                            if (!isActive(epoch)) {
                                ws.cancel();
                                return;
                            }
                            webSocket = ws;
                            if (!ws.send(config.toString())) {
                                failSession(epoch, "Could not start speech stream.");
                                return;
                            }
                            boolean ok;
                            synchronized (audioLock) {
                                sonioxReady = true;
                                ok = flushPendingLocked(ws);
                                AgentTelemetry.note(WakeActivity.this,
                                  dictationMode?"SPEAK_READY":"WAKE_READY",
                                  dictationMode?"SPEAK":"WAKE","SONIOX","NONE");
                            }
                            if (!ok) {
                                failSession(epoch, "Audio send failed.");
                                return;
                            }
                            main.post(() -> {
                                if (isActive(epoch)) setStatus(stopRequested ? "Finalizing…" : phaseStatus());
                            });
                            maybeFinish(epoch);
                        }

                        @Override public void onMessage(WebSocket ws, String text) {
                            handleSoniox(epoch, text);
                        }

                        @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                            if (isActive(epoch)) failSession(epoch, "Speech connection error.");
                        }

                        @Override public void onClosed(WebSocket ws, int code, String reason) {
                            if (isActive(epoch) && !stopRequested) {
                                failSession(epoch, "Speech connection closed.");
                            }
                        }
                    });
        } catch (Exception e) {
            failSession(epoch, "Speech configuration error.");
        }
    }

    private void startAudioCapture(long epoch) {
        new Thread(() -> {
            try {
                int min = AudioRecord.getMinBufferSize(
                        SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT);
                if (min <= 0) throw new IllegalStateException("invalid buffer");

                AudioRecord record = new AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min, AUDIO_CHUNK));
                audioRecord = record;
                if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IllegalStateException("AudioRecord init");
                }
                record.startRecording();

                byte[] buf = new byte[AUDIO_CHUNK];
                while (isActive(epoch) && !stopRequested) {
                    int n = record.read(buf, 0, buf.length);
                    if (n > 0) {
                        byte[] copy = java.util.Arrays.copyOf(buf, n);
                        if (!bufferOrSend(copy, epoch)) {
                            throw new IllegalStateException("send rejected");
                        }
                    } else if (n < 0 && !stopRequested) {
                        throw new IllegalStateException("read error");
                    }
                }
            } catch (Exception e) {
                if (isActive(epoch) && !stopRequested) {
                    main.post(() -> failSession(epoch, "Microphone error."));
                }
            } finally {
                stopAudioRecord();
                synchronized (audioLock) {
                    audioDone = true;
                }
                main.post(() -> maybeFinish(epoch));
            }
        }, "wake-probe-audio").start();
    }

    private boolean bufferOrSend(byte[] chunk, long epoch) {
        synchronized (audioLock) {
            if (!isActive(epoch)) return false;
            if (sonioxReady && webSocket != null) return webSocket.send(ByteString.of(chunk));
            pendingAudio.addLast(chunk);
            pendingBytes += chunk.length;
            while (pendingBytes > MAX_PENDING_BYTES && !pendingAudio.isEmpty()) {
                pendingBytes -= pendingAudio.removeFirst().length;
            }
            return true;
        }
    }

    private boolean flushPendingLocked(WebSocket ws) {
        while (!pendingAudio.isEmpty()) {
            byte[] chunk = pendingAudio.removeFirst();
            pendingBytes -= chunk.length;
            if (!ws.send(ByteString.of(chunk))) {
                pendingAudio.clear();
                pendingBytes = 0;
                return false;
            }
        }
        pendingBytes = 0;
        return true;
    }

    private void maybeFinish(long epoch) {
        if (!isActive(epoch) || !stopRequested) return;
        WebSocket ws;
        synchronized (audioLock) {
            if (!audioDone || !sonioxReady || finishSent || webSocket == null) return;
            if (!flushPendingLocked(webSocket)) {
                failSession(epoch, "Final audio send failed.");
                return;
            }
            finishSent = true;
            ws = webSocket;
        }
        if (!ws.send("")) {
            failSession(epoch, "Could not finalize speech stream.");
            return;
        }
        main.postDelayed(() -> {
            if (isActive(epoch) && stopRequested) {
                forceCommit(epoch);
                stopImmediate(epoch, "Stopped.");
            }
        }, 8000L);
    }

    private void handleSoniox(long epoch, String text) {
        if (!isActive(epoch)) return;
        try {
            JSONObject o = new JSONObject(text);
            if (o.has("error_code") && !o.isNull("error_code")) {
                failSession(epoch, "Soniox returned an error.");
                return;
            }

            JSONArray tokens = o.optJSONArray("tokens");
            boolean heardText = false;
            if (tokens != null) {
                synchronized (textLock) {
                    for (int i = 0; i < tokens.length(); i++) {
                        JSONObject t = tokens.optJSONObject(i);
                        if (t == null) continue;
                        String token = t.optString("text", "");
                        if (token.isEmpty() || isControlToken(token)) continue;
                        heardText = true;
                        if (t.optBoolean("is_final", false)) {
                            String id = t.optLong("start_ms", -1) + "|" +
                                    t.optLong("end_ms", -1) + "|" + token;
                            if (finalTokenIds.add(id)) heldFinal.append(token);
                        }
                    }
                }
            }

            if (heardText) {
                lastSpeechAt = SystemClock.uptimeMillis();
                armCommit(epoch);
            }

            if (o.optBoolean("finished", false)) {
                forceCommit(epoch);
                stopImmediate(epoch, "Stopped.");
            }
        } catch (Exception ignored) {}
    }

    private boolean isControlToken(String token) {
        String s = token == null ? "" : token.trim();
        return "<end>".equalsIgnoreCase(s) || "<fin>".equalsIgnoreCase(s);
    }

    private int activeDelayMs() {
        if(dictationMode) return Math.max(1200,commandDelayMs);
        return listeningPhase == ListeningPhase.COMMAND ? commandDelayMs : wakeDelayMs;
    }

    private String phaseStatus() {
        if(dictationMode) return "Dictation active — speak and then pause.";
        return listeningPhase == ListeningPhase.COMMAND
                ? "Wake received — waiting for command…"
                : "Listening for wake phrase…";
    }

    private void armCommit(long epoch) {
        main.removeCallbacks(commitRunnable);
        int delayMs = activeDelayMs();
        if (delayMs <= 0) main.post(commitRunnable);
        else main.postDelayed(commitRunnable, delayMs);
    }

    private final Runnable commitRunnable = this::runCommitCheck;

    private void runCommitCheck() {
        long epoch = activeEpoch;
        if (!isActive(epoch)) return;
        int delayMs = activeDelayMs();
        long remaining = delayMs - (SystemClock.uptimeMillis() - lastSpeechAt);
        if (remaining > 0) {
            main.postDelayed(commitRunnable, Math.max(60, remaining));
            return;
        }
        commitHeldChunk(epoch);
    }

    private void forceCommit(long epoch) {
        main.post(() -> {
            if (activeEpoch == epoch) commitHeldChunk(epoch);
        });
    }

    private void commitHeldChunk(long epoch) {
        if (activeEpoch != epoch) return;
        String chunk;
        synchronized (textLock) {
            chunk = heldFinal.toString().trim();
            heldFinal.setLength(0);
        }
        if (chunk.isEmpty()) return;

        lastChunk.setText(chunk);

        if(dictationMode){
            if(!hasCommandContent(chunk)){
                setStatus("Ignoring punctuation-only dictation. Continue speaking.");
                return;
            }
            if(!saveForAgent(chunk)) return;
            AgentTelemetry.note(this,"SPEAK_CAPTURED","SPEAK","CAPTURED","NONE");
            playDings(2);
            stopImmediate(epoch,"Dictation saved locally; no remote chat send.");
            main.postDelayed(() -> {
                if(isFinishing() || isDestroyed()) return;
                Intent back=new Intent(this,MainActivity.class);
                back.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(back);
                finish();
            },450L);
            return;
        }

        if (listeningPhase == ListeningPhase.COMMAND) {
            if (!hasCommandContent(chunk)) {
                setStatus("Ignoring punctuation — waiting for command…");
                return;
            }
            if(!saveForAgent(chunk)) return;
            AgentTelemetry.note(this,"WAKE_CAPTURED","WAKE","CAPTURED","NONE");
            playDings(2);
            listeningPhase = ListeningPhase.WAKE;
            setStatus("Command stored locally — listening for wake phrase…");
            return;
        }

        WakeMatch match = classifyWake(
                chunk,
                wakeField.getText().toString(),
                wakeAliasField.getText().toString());
        if (match == WakeMatch.WAKE_ONLY) {
            playDings(1);
            AgentTelemetry.note(this,"WAKE_PHASE","WAKE","WAIT_COMMAND","NONE");
            listeningPhase = ListeningPhase.COMMAND;
            setStatus("Wake received — waiting for command…");
        } else if (match == WakeMatch.WAKE_WITH_COMMAND) {
            String inline=WakeCommandExtractor.inlineCommand(
                    chunk,wakeField.getText().toString(),wakeAliasField.getText().toString());
            if(!saveForAgent(inline)) return;
            AgentTelemetry.note(this,"WAKE_CAPTURED","WAKE","CAPTURED","NONE");
            playDings(2);
            listeningPhase = ListeningPhase.WAKE;
            setStatus("Inline command stored locally — listening for wake phrase…");
        } else if (running && !stopRequested) {
            setStatus("Listening for wake phrase…");
        }
    }

    private boolean saveForAgent(String text) {
        long seq=CommandInbox.capture(this,text);
        if(seq<1L){
          AgentTelemetry.note(this,dictationMode?"SPEAK_ERROR":"WAKE_ERROR",
            dictationMode?"SPEAK":"WAKE","ERROR","STORE");
          setStatus("Command not saved — no receipt was acknowledged.");
          return false;
        }
        if(capturedCommand!=null) capturedCommand.setText("Saved agent command: " + text);
        return true;
    }

    private enum WakeMatch {
        NONE,
        WAKE_ONLY,
        WAKE_WITH_COMMAND
    }

    private WakeMatch classifyWake(String chunk, String... wakeAliases) {
        WakeMatch best = WakeMatch.NONE;
        for (String wake : wakeAliases) {
            WakeMatch match = classifySingleWake(chunk, wake);
            if (match == WakeMatch.WAKE_ONLY) return WakeMatch.WAKE_ONLY;
            if (match == WakeMatch.WAKE_WITH_COMMAND) best = WakeMatch.WAKE_WITH_COMMAND;
        }
        return best;
    }

    private WakeMatch classifySingleWake(String chunk, String wake) {
        String c = normalizeForMatch(chunk);
        String w = normalizeForMatch(wake);
        if (w.isEmpty() || c.isEmpty()) return WakeMatch.NONE;
        if (c.equals(w)) return WakeMatch.WAKE_ONLY;
        if (!c.startsWith(w) || c.length() <= w.length()) return WakeMatch.NONE;
        int next = c.codePointAt(w.length());
        if (!isBoundary(next)) return WakeMatch.NONE;
        String tail = c.substring(w.length());
        return hasCommandContent(tail) ? WakeMatch.WAKE_WITH_COMMAND : WakeMatch.WAKE_ONLY;
    }

    private boolean hasCommandContent(String tail) {
        for (int i = 0; i < tail.length();) {
            int cp = tail.codePointAt(i);
            if (Character.isLetterOrDigit(cp)) return true;
            i += Character.charCount(cp);
        }
        return false;
    }

    private String normalizeForMatch(String s) {
        if (s == null) return "";
        return s
                .replace('ي', 'ی')
                .replace('ى', 'ی')
                .replace('ك', 'ک')
                .replace('‌', ' ')
                .replace("ـ", "")
                .replaceAll("[ً-ٰٟ]", "")
                .trim()
                .replaceAll("\\s+", " ")
                .toLowerCase(Locale.ROOT);
    }

    private boolean isBoundary(int cp) {
        if (Character.isWhitespace(cp)) return true;
        int type = Character.getType(cp);
        return type == Character.CONNECTOR_PUNCTUATION
                || type == Character.DASH_PUNCTUATION
                || type == Character.START_PUNCTUATION
                || type == Character.END_PUNCTUATION
                || type == Character.INITIAL_QUOTE_PUNCTUATION
                || type == Character.FINAL_QUOTE_PUNCTUATION
                || type == Character.OTHER_PUNCTUATION;
    }

    private void playDings(int count) {
        playDing();
        if (count > 1) main.postDelayed(this::playDing, 260L);
    }

    private void playDing() {
        try {
            if (tone != null) tone.startTone(ToneGenerator.TONE_PROP_ACK, 160);
        } catch (Exception ignored) {}
    }

    private void failSession(long epoch, String message) {
        main.post(() -> {
            if (!isActive(epoch)) return;
            forceCommit(epoch);
            AgentTelemetry.note(this,dictationMode?"SPEAK_ERROR":"WAKE_ERROR",
              dictationMode?"SPEAK":"WAKE","ERROR","STT");
            stopImmediate(epoch, message);
        });
    }

    private void stopImmediate(long epoch, String message) {
        if (activeEpoch != epoch) return;
        running = false;
        stopRequested = true;
        awaitingCredential = false;
        listeningPhase = ListeningPhase.WAKE;
        main.removeCallbacks(commitRunnable);
        stopAudioRecord();
        synchronized (audioLock) {
            pendingAudio.clear();
            pendingBytes = 0;
            sonioxReady = false;
        }
        WebSocket ws = webSocket;
        webSocket = null;
        if (ws != null) {
            try { ws.close(1000, "stop"); } catch (Exception ignored) {}
        }
        stopKeepAliveService();
        if(!dictationMode)
          AgentTelemetry.note(this,"WAKE_STOP","WAKE","STOPPED","NONE");
        startStop.setText(dictationMode ? "Start dictating" : "Start listening");
        setStatus(message);
    }

    private void stopAudioRecord() {
        AudioRecord r = audioRecord;
        audioRecord = null;
        if (r != null) {
            try {
                if (r.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) r.stop();
            } catch (Exception ignored) {}
            try { r.release(); } catch (Exception ignored) {}
        }
    }

    private boolean keepListeningLocked() {
        if(dictationMode) return false;
        if (lockedModeBox != null) return lockedModeBox.isChecked();
        return prefs != null && prefs.getBoolean(PREF_LOCKED, false);
    }

    private boolean isDeviceLockedOrScreenOff() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean screenOff = pm != null && !pm.isInteractive();
        boolean locked = km != null && km.isKeyguardLocked();
        return screenOff || locked;
    }

    private void startKeepAliveService() {
        Intent i = new Intent(this, LockedListeningService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception e) {
            setStatus("Locked-screen listening could not start.");
        }
    }

    private void stopKeepAliveService() {
        try { stopService(new Intent(this, LockedListeningService.class)); }
        catch (Exception ignored) {}
    }

    private void setStatus(String text) {
        if (status != null) status.setText(text);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureAuthWebView() {
        WebSettings s = auth.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(MOBILE_BROWSER_UA);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(auth, true);

        auth.addJavascriptInterface(new CredentialBridge(), "AndroidProbe");
        auth.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                String host = null;
                try { host = Uri.parse(url).getHost(); } catch (Exception ignored) {}
                pageReady = host != null &&
                        (host.equals("perplexity.ai") || host.endsWith(".perplexity.ai"));

                long epoch = activeEpoch;
                if (isActive(epoch) && awaitingCredential && retryAfterPageLoad && pageReady) {
                    retryAfterPageLoad = false;
                    main.postDelayed(() -> requestCredential(epoch), 350L);
                } else if (!running) {
                    if(dictationMode && autoStartPending && pageReady){
                        autoStartPending=false;
                        setStatus("Preparing Soniox dictation; microphone permission may be requested.");
                        main.postDelayed(() -> {
                            if(!running && !isFinishing() && activityResumed) beginStart();
                        },450L);
                    } else {
                        setStatus(pageReady ?
                                "Perplexity session ready." :
                                "Open the Perplexity session once.");
                    }
                }
            }
        });
    }

    private final class CredentialBridge {
        @JavascriptInterface public void credential(String apiKey, String expiresAt) {
            long epoch = activeEpoch;
            main.post(() -> {
                if (!isActive(epoch) || !awaitingCredential) return;
                awaitingCredential = false;
                retryAfterPageLoad = false;
                if (apiKey == null || apiKey.isEmpty()) {
                    failSession(epoch, "Perplexity returned no speech credential.");
                    return;
                }
                startSoniox(apiKey, epoch);
            });
        }

        @JavascriptInterface public void credentialError(String error) {
            long epoch = activeEpoch;
            main.post(() -> {
                if (!isActive(epoch) || !awaitingCredential) return;
                if (credentialAttempt < 3 && auth != null) {
                    retryAfterPageLoad = true;
                    pageReady = false;
                    setStatus("Refreshing Perplexity session…");
                    try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
                    auth.reload();
                    main.postDelayed(() -> {
                        if (isActive(epoch) && awaitingCredential && retryAfterPageLoad) {
                            retryAfterPageLoad = false;
                            requestCredential(epoch);
                        }
                    }, 1600L);
                    return;
                }
                awaitingCredential = false;
                failSession(epoch, "Perplexity speech credential failed.");
            });
        }
    }

    @Override protected void onResume() {
        super.onResume();
        activityResumed = true;
        if (auth != null && !running) {
            try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
            auth.reload();
        }
    }

    @Override protected void onPause() {
        activityResumed = false;
        if (running) {
            long epoch = activeEpoch;
            main.postDelayed(() -> {
                if (!isActive(epoch) || activityResumed) return;
                if (keepListeningLocked() && isDeviceLockedOrScreenOff()) {
                    AgentTelemetry.note(this,"WAKE_PHASE","WAKE","LISTENING","NONE");
                    setStatus("Listening while screen is locked…");
                    return;
                }
                forceCommit(epoch);
                stopImmediate(epoch, "Paused.");
            }, 350L);
        }
        super.onPause();
    }

    @Override protected void onDestroy() {
        boolean preserveLockedRun = running
                && keepListeningLocked()
                && isDeviceLockedOrScreenOff();
        saveWakePhrases();
        if (!preserveLockedRun) {
            if (running) stopImmediate(activeEpoch, "Stopped.");
            if (auth != null) {
                auth.removeJavascriptInterface("AndroidProbe");
                auth.destroy();
            }
            if (tone != null) {
                tone.release();
                tone = null;
            }
            http.dispatcher().executorService().shutdown();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static final String FETCH_CREDENTIAL_JS =
            "(async function(){try{" +
            "const tz=(Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');" +
            "const r=await fetch('/rest/realtime/v1/transcription/soniox-api-key',{method:'POST',credentials:'include',headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({source:'android',timezone:tz,version:'2.97.0'})});" +
            "if(!r.ok){AndroidProbe.credentialError('http '+r.status);return;}" +
            "const j=await r.json();if(!j||!j.api_key){AndroidProbe.credentialError('no key');return;}" +
            "AndroidProbe.credential(String(j.api_key),String(j.expires_at||''));" +
            "}catch(e){AndroidProbe.credentialError(String(e&&e.name||'Error'));}})()";
}
