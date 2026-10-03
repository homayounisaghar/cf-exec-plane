package com.najme.shenavatest;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.inputmethodservice.InputMethodService;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputConnection;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicInteger;

public class ShenavaImeService extends InputMethodService {
    private static final int SAMPLE_RATE = 16000;
    private static final int CHUNK_SAMPLES = 1600; // 100 ms

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger generation = new AtomicInteger(0);
    private final Object modelLock = new Object();

    private volatile boolean modelReady = false;
    private volatile boolean modelLoading = false;
    private volatile String modelError = null;
    private OnlineRecognizer recognizer;

    private volatile boolean voiceActive = false;
    private volatile boolean finalizeRequested = false;
    private volatile Thread recordingThread;
    private volatile AudioRecord audioRecord;

    private TextView statusView;
    private Button micButton;

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        initModelAsync();
    }

    @Override
    public View onCreateInputView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(5), dp(5), dp(5), dp(6));
        root.setBackgroundColor(Color.rgb(239, 239, 244));
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

        micButton = keyButton("🎙");
        micButton.setTextSize(22);
        micButton.setOnClickListener(v -> toggleVoice());
        bar.addView(micButton, new LinearLayout.LayoutParams(dp(58), dp(48)));

        statusView = new TextView(this);
        statusView.setTextSize(13);
        statusView.setTextColor(Color.rgb(45, 45, 52));
        statusView.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        statusView.setTextDirection(View.TEXT_DIRECTION_RTL);
        statusView.setPadding(dp(8), 0, dp(8), 0);
        bar.addView(statusView, new LinearLayout.LayoutParams(0, dp(48), 1f));

        Button globe = keyButton("🌐");
        globe.setTextSize(20);
        globe.setOnClickListener(v -> switchToNextInputMethod(false));
        bar.addView(globe, new LinearLayout.LayoutParams(dp(54), dp(48)));
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(50)));

        addLetterRow(root, new String[]{"ض","ص","ث","ق","ف","غ","ع","ه","خ","ح","ج","چ"});
        addLetterRow(root, new String[]{"ش","س","ی","ب","ل","ا","ت","ن","م","ک","گ"});
        addLetterRow(root, new String[]{"ظ","ط","ز","ر","ذ","د","پ","و",".","،","؟"});

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

        Button backspace = keyButton("⌫");
        backspace.setOnClickListener(v -> {
            cancelVoiceForManualInput();
            InputConnection ic = getCurrentInputConnection();
            if (ic != null) ic.deleteSurroundingText(1, 0);
        });
        bottom.addView(backspace, new LinearLayout.LayoutParams(0, dp(46), 1.2f));

        Button zwnj = keyButton("نیم‌فاصله");
        zwnj.setTextSize(12);
        zwnj.setOnClickListener(v -> commitManual("\u200c"));
        bottom.addView(zwnj, new LinearLayout.LayoutParams(0, dp(46), 1.6f));

        Button space = keyButton("فاصله");
        space.setTextSize(13);
        space.setOnClickListener(v -> commitManual(" "));
        bottom.addView(space, new LinearLayout.LayoutParams(0, dp(46), 3.2f));

        Button enter = keyButton("↵");
        enter.setTextSize(20);
        enter.setOnClickListener(v -> commitManual("\n"));
        bottom.addView(enter, new LinearLayout.LayoutParams(0, dp(46), 1.2f));
        root.addView(bottom, new LinearLayout.LayoutParams(-1, dp(48)));

        refreshStatus();
        return root;
    }

    private void addLetterRow(LinearLayout root, String[] labels) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        for (String label : labels) {
            Button b = keyButton(label);
            b.setOnClickListener(v -> commitManual(label));
            row.addView(b, new LinearLayout.LayoutParams(0, dp(44), 1f));
        }
        root.addView(row, new LinearLayout.LayoutParams(-1, dp(46)));
    }

    private Button keyButton(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(17);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(1), 0, dp(1), 0);
        return b;
    }

    private void commitManual(String value) {
        cancelVoiceForManualInput();
        InputConnection ic = getCurrentInputConnection();
        if (ic != null) ic.commitText(value, 1);
    }

    private void cancelVoiceForManualInput() {
        if (voiceActive || (recordingThread != null && recordingThread.isAlive())) {
            stopVoice(false);
        }
        InputConnection ic = getCurrentInputConnection();
        if (ic != null) ic.finishComposingText();
    }

    private void toggleVoice() {
        if (voiceActive) {
            stopVoice(true);
        } else {
            startVoice();
        }
    }

    private void startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus("مجوز میکروفون لازم است — اپ Shenava Keyboard Test را باز کنید");
            return;
        }
        if (!modelReady) {
            if (modelError != null) setStatus("خطای مدل: " + modelError);
            else setStatus("مدل شنوا هنوز در حال آماده‌شدن است…");
            initModelAsync();
            return;
        }
        Thread previous = recordingThread;
        if (previous != null && previous.isAlive()) {
            setStatus("یک لحظه… نشست قبلی در حال بسته‌شدن است");
            return;
        }

        final int gen = generation.incrementAndGet();
        finalizeRequested = false;
        voiceActive = true;
        updateMicVisual(true);
        setStatus("شنوا محلی — در حال گوش‌دادن");

        Thread t = new Thread(() -> runRecognition(gen), "shenava-local-asr");
        recordingThread = t;
        t.start();
    }

    private void stopVoice(boolean finalizeText) {
        if (!voiceActive && (recordingThread == null || !recordingThread.isAlive())) return;
        finalizeRequested = finalizeText;
        voiceActive = false;
        if (!finalizeText) generation.incrementAndGet();
        updateMicVisual(false);
        AudioRecord r = audioRecord;
        if (r != null) {
            try { r.stop(); } catch (Exception ignored) {}
        }
        setStatus(finalizeText ? "در حال نهایی‌کردن متن…" : "آماده");
    }

    private void runRecognition(int gen) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        OnlineStream localStream = null;
        AudioRecord localRecord = null;
        String lastText = "";
        try {
            synchronized (modelLock) {
                if (recognizer == null) throw new IllegalStateException("recognizer unavailable");
                localStream = recognizer.createStream();
            }

            int minBytes = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            int bufferBytes = Math.max(minBytes, CHUNK_SAMPLES * 2 * 4);
            localRecord = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes);
            if (localRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("AudioRecord init failed");
            }
            audioRecord = localRecord;
            localRecord.startRecording();

            short[] pcm = new short[CHUNK_SAMPLES];
            while (voiceActive && gen == generation.get()) {
                int n = localRecord.read(pcm, 0, pcm.length);
                if (n <= 0) continue;
                float[] samples = new float[n];
                for (int i = 0; i < n; i++) samples[i] = pcm[i] / 32768.0f;

                long start = System.nanoTime();
                String text;
                synchronized (modelLock) {
                    localStream.acceptWaveform(samples, SAMPLE_RATE);
                    while (recognizer.isReady(localStream)) recognizer.decode(localStream);
                    text = recognizer.getResult(localStream).getText().trim();
                }
                long decodeMs = (System.nanoTime() - start) / 1_000_000L;

                if (!text.equals(lastText)) {
                    lastText = text;
                    publishPartial(text, gen, decodeMs);
                } else {
                    publishLatencyOnly(gen, decodeMs);
                }
            }

            boolean shouldFinalize = finalizeRequested && gen == generation.get();
            if (shouldFinalize) {
                String finalText;
                synchronized (modelLock) {
                    float[] tail = new float[(int)(SAMPLE_RATE * 0.35f)];
                    localStream.acceptWaveform(tail, SAMPLE_RATE);
                    localStream.inputFinished();
                    while (recognizer.isReady(localStream)) recognizer.decode(localStream);
                    finalText = recognizer.getResult(localStream).getText().trim();
                }
                publishFinal(finalText, gen);
            }
        } catch (Throwable e) {
            if (gen == generation.get()) {
                setStatus("خطای شنوا: " + safeMessage(e));
                updateMicVisual(false);
            }
        } finally {
            if (localRecord != null) {
                try { localRecord.stop(); } catch (Exception ignored) {}
                try { localRecord.release(); } catch (Exception ignored) {}
            }
            audioRecord = null;
            if (localStream != null) {
                try { localStream.release(); } catch (Exception ignored) {}
            }
            if (recordingThread == Thread.currentThread()) recordingThread = null;
            if (gen == generation.get()) {
                voiceActive = false;
                finalizeRequested = false;
                updateMicVisual(false);
            }
        }
    }

    private void publishPartial(String text, int gen, long decodeMs) {
        main.post(() -> {
            if (!voiceActive || gen != generation.get()) return;
            InputConnection ic = getCurrentInputConnection();
            if (ic != null) ic.setComposingText(text, 1);
            if (statusView != null) statusView.setText("شنوا محلی • " + decodeMs + " ms");
        });
    }

    private void publishLatencyOnly(int gen, long decodeMs) {
        main.post(() -> {
            if (!voiceActive || gen != generation.get()) return;
            if (statusView != null) statusView.setText("شنوا محلی • " + decodeMs + " ms");
        });
    }

    private void publishFinal(String text, int gen) {
        main.post(() -> {
            if (gen != generation.get()) return;
            InputConnection ic = getCurrentInputConnection();
            if (ic != null) {
                if (!text.isEmpty()) ic.setComposingText(text, 1);
                ic.finishComposingText();
            }
            setStatus("آماده — متن روی خود گوشی پردازش شد");
        });
    }

    private void initModelAsync() {
        if (modelReady || modelLoading) return;
        modelLoading = true;
        modelError = null;
        setStatus("در حال آماده‌سازی مدل محلی شنوا…");
        new Thread(() -> {
            try {
                File dir = new File(getFilesDir(), "shenava-rizeh-v1");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create model dir");
                File model = new File(dir, "model.int8.onnx");
                File tokens = new File(dir, "tokens.txt");
                copyAssetIfNeeded("shenava/model.int8.onnx", model, 1_000_000L);
                copyAssetIfNeeded("shenava/tokens.txt", tokens, 1000L);

                OnlineNeMoCtcModelConfig nemo = OnlineNeMoCtcModelConfig.builder()
                        .setModel(model.getAbsolutePath())
                        .build();
                OnlineModelConfig modelConfig = OnlineModelConfig.builder()
                        .setNeMoCtc(nemo)
                        .setTokens(tokens.getAbsolutePath())
                        .setNumThreads(4)
                        .setDebug(false)
                        .build();
                FeatureConfig featureConfig = FeatureConfig.builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setFeatureDim(80)
                        .setDither(0.0f)
                        .build();
                OnlineRecognizerConfig config = OnlineRecognizerConfig.builder()
                        .setFeatureConfig(featureConfig)
                        .setOnlineModelConfig(modelConfig)
                        .setEnableEndpoint(false)
                        .setDecodingMethod("greedy_search")
                        .build();

                OnlineRecognizer newRecognizer = new OnlineRecognizer(config);
                synchronized (modelLock) {
                    if (recognizer != null) recognizer.release();
                    recognizer = newRecognizer;
                }
                modelReady = true;
                setStatus("آماده — Shenava Rizeh محلی");
            } catch (Throwable e) {
                modelError = safeMessage(e);
                setStatus("خطای بارگذاری مدل: " + modelError);
            } finally {
                modelLoading = false;
            }
        }, "shenava-model-init").start();
    }

    private void copyAssetIfNeeded(String assetPath, File output, long minimumBytes) throws Exception {
        if (output.isFile() && output.length() >= minimumBytes) return;
        File tmp = new File(output.getParentFile(), output.getName() + ".tmp");
        try (InputStream in = getAssets().open(assetPath);
             FileOutputStream out = new FileOutputStream(tmp)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (n > 0) out.write(buffer, 0, n);
            }
            out.getFD().sync();
        }
        if (output.exists() && !output.delete()) throw new IllegalStateException("cannot replace model file");
        if (!tmp.renameTo(output)) throw new IllegalStateException("cannot install model file");
    }

    private String safeMessage(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.trim().isEmpty()) return e.getClass().getSimpleName();
        return m.length() > 120 ? m.substring(0, 120) : m;
    }

    private void setStatus(String value) {
        main.post(() -> {
            if (statusView != null) statusView.setText(value);
        });
    }

    private void refreshStatus() {
        if (modelError != null) setStatus("خطای مدل: " + modelError);
        else if (modelReady) setStatus("آماده — Shenava Rizeh محلی");
        else setStatus("در حال آماده‌سازی مدل محلی شنوا…");
    }

    private void updateMicVisual(boolean active) {
        main.post(() -> {
            if (micButton != null) micButton.setText(active ? "■" : "🎙");
        });
    }

    @Override
    public void onFinishInputView(boolean finishingInput) {
        stopVoice(false);
        super.onFinishInputView(finishingInput);
    }

    @Override
    public void onFinishInput() {
        stopVoice(false);
        super.onFinishInput();
    }

    @Override
    public void onWindowHidden() {
        stopVoice(false);
        super.onWindowHidden();
    }

    @Override
    public void onDestroy() {
        stopVoice(false);
        OnlineRecognizer r;
        synchronized (modelLock) {
            r = recognizer;
            recognizer = null;
        }
        if (r != null) {
            try { r.release(); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
