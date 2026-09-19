package com.mana.local.tacotron2.bench;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.text.InputType;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.PowerManager;
import android.view.DisplayCutout;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final int REQ_PACK = 1001;
    private static final String[] REQUIRED = new String[]{
            "voice-pack-manifest.json",
            "tacotron_encoder.onnx",
            "decoder_step.onnx",
            "postnet.onnx",
            "hifigan.onnx",
            "speaker_embed.f32",
            "benchmark_inputs.json"
    };

    private TextView status;
    private Button choosePack;
    private EditText customText;
    private EditText speedInput;
    private Button synthesizeText;
    private Button quickBench;
    private Button fullRender;
    private Button playLast;
    private File packDir;
    private File lastWav;
    private String lastReport = "";
    private float lastPlaybackSpeed = 1.0f;
    private static final Pattern PAUSE_MARKER = Pattern.compile("\\[(\\d{1,5})\\]");

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(24, 24, 24, 24);
        body.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("Mana Voice Playground");
        title.setTextSize(20f);
        title.setTextColor(Color.BLACK);
        body.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView note = new TextView(this);
        note.setText("کاملاً آفلاین. Voice Pack را یک بار وارد کن، متن فارسی خودت را بنویس و صدای Mana را روی همین گوشی بساز.");
        note.setTextSize(14f);
        note.setTextColor(Color.DKGRAY);
        note.setPadding(0, 8, 0, 16);
        body.addView(note);

        choosePack = button("۱) وارد کردن Voice Pack");

        customText = new EditText(this);
        customText.setHint("متن فارسی خودت را اینجا بنویس");
        customText.setMinLines(4);
        customText.setMaxLines(10);
        customText.setTextDirection(View.TEXT_DIRECTION_RTL);
        customText.setTextAlignment(View.TEXT_ALIGNMENT_VIEW_END);
        customText.setText("سلام دنیا. این یک آزمایش صدای مانا است.");

        TextView syntaxHelp = new TextView(this);
        syntaxHelp.setText("برای مکث داخل متن بنویس: [700]  یعنی ۷۰۰ میلی ثانیه سکوت.");
        syntaxHelp.setTextSize(13f);
        syntaxHelp.setTextColor(Color.DKGRAY);
        syntaxHelp.setPadding(0, 8, 0, 4);

        speedInput = new EditText(this);
        speedInput.setHint("سرعت پخش، مثلاً 1.0");
        speedInput.setText("1.0");
        speedInput.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);

        synthesizeText = button("۲) خواندن متن من");
        quickBench = button("Benchmark سریع");
        fullRender = button("Render تست های مرجع");
        playLast = button("پخش دوباره آخرین صدا");
        synthesizeText.setEnabled(false);
        quickBench.setEnabled(false);
        fullRender.setEnabled(false);
        playLast.setEnabled(false);

        body.addView(choosePack);
        body.addView(customText);
        body.addView(syntaxHelp);
        body.addView(speedInput);
        body.addView(synthesizeText);
        body.addView(playLast);
        body.addView(quickBench);
        body.addView(fullRender);

        status = new TextView(this);
        status.setTextSize(12f);
        status.setTextColor(Color.BLACK);
        status.setTextIsSelectable(true);
        status.setPadding(0, 16, 0, 32);
        body.addView(status, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(body);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
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
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        setContentView(scroll);
        scroll.requestApplyInsets();

        choosePack.setOnClickListener(v -> selectPack());
        synthesizeText.setOnClickListener(v -> synthesizeCustomText());
        quickBench.setOnClickListener(v -> runAsync(false));
        fullRender.setOnClickListener(v -> runAsync(true));
        playLast.setOnClickListener(v -> playLast());

        packDir = new File(getFilesDir(), "mana-phase3-pack");
        if (validateInstalledPack(packDir, false)) {
            setReady(true);
            log("Existing voice pack is valid: " + packDir.getAbsolutePath());
        } else {
            log("Import the Phase-3 voice pack ZIP.");
        }
    }

    private Button button(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        return b;
    }

    private void setReady(boolean ready) {
        synthesizeText.setEnabled(ready);
        quickBench.setEnabled(ready);
        fullRender.setEnabled(ready);
    }

    private void selectPack() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/zip");
        startActivityForResult(i, REQ_PACK);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PACK && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            setReady(false);
            log("Importing voice pack...");
            new Thread(() -> {
                try {
                    importPack(uri);
                    runOnUiThread(() -> {
                        setReady(true);
                        log("Voice pack READY.");
                    });
                } catch (Throwable t) {
                    runOnUiThread(() -> log("IMPORT FAILED: " + t));
                }
            }, "mana-pack-import").start();
        }
    }

    private void importPack(Uri uri) throws Exception {
        File tmp = new File(getFilesDir(), "mana-phase3-pack.tmp");
        deleteRecursive(tmp);
        if (!tmp.mkdirs()) throw new IllegalStateException("cannot create temp pack dir");

        try (InputStream raw = getContentResolver().openInputStream(uri);
             ZipInputStream zin = new ZipInputStream(new BufferedInputStream(raw))) {
            ZipEntry e;
            byte[] buf = new byte[1024 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                String name = new File(e.getName()).getName();
                if (!isAllowed(name)) continue;
                File out = new File(tmp, name);
                try (BufferedOutputStream o = new BufferedOutputStream(new FileOutputStream(out))) {
                    int n;
                    while ((n = zin.read(buf)) > 0) o.write(buf, 0, n);
                }
            }
        }

        if (!validateInstalledPack(tmp, true)) throw new IllegalStateException("voice pack validation failed");
        deleteRecursive(packDir);
        if (!tmp.renameTo(packDir)) throw new IllegalStateException("cannot activate voice pack");
    }

    private boolean isAllowed(String name) {
        for (String s : REQUIRED) if (s.equals(name)) return true;
        return false;
    }

    private boolean validateInstalledPack(File dir, boolean strict) {
        try {
            for (String n : REQUIRED) {
                File f = new File(dir, n);
                if (!f.isFile() || f.length() == 0) throw new IllegalStateException("missing " + n);
            }
            JSONObject manifest = new JSONObject(readText(new File(dir, "voice-pack-manifest.json")));
            if (!"mana.tacotron2.android-voice-pack.v1".equals(manifest.getString("schema"))) {
                throw new IllegalStateException("bad voice pack schema");
            }
            JSONObject files = manifest.getJSONObject("files");
            for (String n : REQUIRED) {
                if ("voice-pack-manifest.json".equals(n)) continue;
                String expected = files.getJSONObject(n).getString("sha256").toLowerCase(Locale.ROOT);
                String actual = sha256(new File(dir, n));
                if (!expected.equals(actual)) throw new IllegalStateException("sha mismatch: " + n);
            }
            return true;
        } catch (Throwable t) {
            if (strict) logFromWorker("PACK INVALID: " + t);
            return false;
        }
    }


    private void synthesizeCustomText() {
        final String raw = customText.getText().toString();
        if (raw.trim().isEmpty()) {
            log("متن خالی است.");
            return;
        }
        final float speed = parseSpeed(speedInput.getText().toString());

        choosePack.setEnabled(false);
        synthesizeText.setEnabled(false);
        quickBench.setEnabled(false);
        fullRender.setEnabled(false);
        playLast.setEnabled(false);

        new Thread(() -> {
            try {
                List<CustomPart> parts = parseCustomParts(raw);
                if (parts.isEmpty()) throw new IllegalArgumentException("هیچ بخش قابل خواندنی پیدا نشد.");

                List<File> rendered = new ArrayList<>();
                List<Integer> pausesAfter = new ArrayList<>();
                int renderIndex = 0;

                try (ModelSessions sessions = ModelSessions.load(packDir, 2)) {
                    for (CustomPart part : parts) {
                        String normalized = PersianFrontend.normalizeTextForSynthesis(part.text);
                        List<String> segments = PersianFrontend.splitNormalized(normalized);
                        for (int si = 0; si < segments.size(); si++) {
                            PersianFrontend.Encoded encoded = PersianFrontend.encodeOovGuard(segments.get(si));
                            if (!encoded.dropped.isEmpty()) {
                                logFromWorker("کاراکترهای پشتیبانی نشده حذف شدند: " + encoded.dropped);
                            }
                            if (encoded.ids.length == 0) continue;

                            logFromWorker("در حال ساخت بخش " + (renderIndex + 1) + "...");
                            SynthesisResult result = synthesize(
                                    sessions,
                                    encoded.ids,
                                    new Random(2026091900L + (renderIndex * 10L)),
                                    true
                            );
                            rendered.add(new File(result.wavPath));
                            int pause = (si == segments.size() - 1) ? part.pauseAfterMs : 120;
                            pausesAfter.add(pause);
                            renderIndex++;
                        }
                    }
                }

                if (rendered.isEmpty()) throw new IllegalStateException("مدل هیچ صدایی تولید نکرد.");
                File combined = combineRenderedWavs(rendered, pausesAfter);
                lastWav = combined;
                lastPlaybackSpeed = speed;
                logFromWorker("آماده است. سرعت پخش: " + speed + "x");
                runOnUiThread(this::playLast);
            } catch (Throwable t) {
                logFromWorker("SYNTHESIS FAILED: " + t);
            } finally {
                runOnUiThread(() -> {
                    choosePack.setEnabled(true);
                    synthesizeText.setEnabled(true);
                    quickBench.setEnabled(true);
                    fullRender.setEnabled(true);
                    playLast.setEnabled(lastWav != null && lastWav.isFile());
                });
            }
        }, "mana-custom-text").start();
    }

    private float parseSpeed(String raw) {
        try {
            float v = Float.parseFloat(raw.trim());
            return Math.max(0.5f, Math.min(2.0f, v));
        } catch (Throwable ignored) {
            return 1.0f;
        }
    }

    private List<CustomPart> parseCustomParts(String raw) {
        List<CustomPart> out = new ArrayList<>();
        Matcher m = PAUSE_MARKER.matcher(raw);
        int pos = 0;
        while (m.find()) {
            String text = raw.substring(pos, m.start()).trim();
            int pause = Math.max(0, Math.min(10000, Integer.parseInt(m.group(1))));
            if (!text.isEmpty()) {
                out.add(new CustomPart(text, pause));
            } else if (!out.isEmpty()) {
                out.get(out.size() - 1).pauseAfterMs =
                        Math.min(10000, out.get(out.size() - 1).pauseAfterMs + pause);
            }
            pos = m.end();
        }
        String tail = raw.substring(pos).trim();
        if (!tail.isEmpty()) out.add(new CustomPart(tail, 0));
        return out;
    }

    private File combineRenderedWavs(List<File> wavs, List<Integer> pausesAfter) throws Exception {
        if (wavs.size() != pausesAfter.size()) throw new IllegalArgumentException("wav/pause size mismatch");
        List<float[]> audio = new ArrayList<>();
        long total = 0L;
        for (int i = 0; i < wavs.size(); i++) {
            float[] a = readWavMono16(wavs.get(i));
            audio.add(a);
            total += a.length;
            total += (24000L * pausesAfter.get(i)) / 1000L;
        }
        if (total > Integer.MAX_VALUE) throw new IllegalStateException("متن برای ترکیب صدا بیش از حد بلند است.");

        float[] merged = new float[(int) total];
        int cursor = 0;
        for (int i = 0; i < audio.size(); i++) {
            float[] a = audio.get(i);
            System.arraycopy(a, 0, merged, cursor, a.length);
            cursor += a.length;
            cursor += (24000 * pausesAfter.get(i)) / 1000;
        }

        File outDir = new File(getFilesDir(), "renders");
        if (!outDir.isDirectory() && !outDir.mkdirs()) throw new IllegalStateException("cannot create renders");
        File out = new File(outDir, "mana-custom-" + System.currentTimeMillis() + ".wav");
        writeWav(out, merged, 24000);
        return out;
    }

    private static float[] readWavMono16(File f) throws Exception {
        byte[] b = readAll(new FileInputStream(f));
        if (b.length < 44) throw new IllegalStateException("bad WAV");
        int dataBytes = b.length - 44;
        if ((dataBytes & 1) != 0) throw new IllegalStateException("bad WAV PCM length");
        float[] out = new float[dataBytes / 2];
        ByteBuffer bb = ByteBuffer.wrap(b, 44, dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < out.length; i++) out[i] = bb.getShort() / 32768f;
        return out;
    }

    private static final class CustomPart {
        final String text;
        int pauseAfterMs;
        CustomPart(String text, int pauseAfterMs) {
            this.text = text;
            this.pauseAfterMs = pauseAfterMs;
        }
    }

    private void runAsync(boolean renderAll) {
        choosePack.setEnabled(false);
        quickBench.setEnabled(false);
        fullRender.setEnabled(false);
        new Thread(() -> {
            try {
                BenchmarkReport report = renderAll ? runFullRender() : runQuick();
                lastReport = report.json.toString(2);
                logFromWorker(lastReport);
            } catch (Throwable t) {
                logFromWorker("BENCH FAILED: " + t);
            } finally {
                runOnUiThread(() -> {
                    choosePack.setEnabled(true);
                    quickBench.setEnabled(true);
                    fullRender.setEnabled(true);
                    playLast.setEnabled(lastWav != null && lastWav.isFile());
                });
            }
        }, renderAll ? "mana-full-render" : "mana-quick-bench").start();
    }

    private BenchmarkReport runQuick() throws Exception {
        JSONObject root = baseReport("quick");
        JSONArray runs = new JSONArray();
        int[] threadSweep = new int[]{1, 2, 4, 6};
        List<int[]> cases = loadCases();
        int[] ids = cases.get(0);
        for (int threads : threadSweep) {
            logFromWorker("Quick benchmark: threads=" + threads);
            try (ModelSessions s = ModelSessions.load(packDir, threads)) {
                SynthesisResult r = synthesize(s, ids, new Random(2026091900L), true);
                JSONObject j = r.toJson();
                j.put("threads", threads);
                j.put("pinMode", "unavailable-java-v0.1");
                j.put("rssKb", rssKb());
                j.put("thermalStatus", thermalStatus());
                runs.put(j);
            }
        }
        root.put("runs", runs);
        root.put("note", "v0.1 measures unpinned thread sweep. Big-core affinity is recorded open for the next diagnostic build.");
        return new BenchmarkReport(root);
    }

    private BenchmarkReport runFullRender() throws Exception {
        JSONObject root = baseReport("render-all");
        JSONArray rendered = new JSONArray();
        List<int[]> cases = loadCases();
        long start = System.nanoTime();
        try (ModelSessions s = ModelSessions.load(packDir, 2)) {
            for (int i = 0; i < cases.size(); i++) {
                logFromWorker("Rendering case " + (i + 1) + "/" + cases.size());
                SynthesisResult r = synthesize(s, cases.get(i), new Random(2026091900L + i * 10L), true);
                JSONObject j = r.toJson();
                j.put("caseIndex", i);
                rendered.put(j);
            }
        }
        root.put("cases", rendered);
        root.put("elapsedSeconds", (System.nanoTime() - start) / 1e9);
        root.put("rssKb", rssKb());
        root.put("thermalStatus", thermalStatus());
        return new BenchmarkReport(root);
    }

    private JSONObject baseReport(String mode) throws Exception {
        JSONObject m = new JSONObject(readText(new File(packDir, "voice-pack-manifest.json")));
        JSONObject root = new JSONObject();
        root.put("schema", "mana.tacotron2.android-benchmark-report.v1");
        root.put("mode", mode);
        root.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        root.put("android", Build.VERSION.RELEASE + " api" + Build.VERSION.SDK_INT);
        root.put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)));
        root.put("voicePack", m.getString("packId"));
        root.put("onnxRuntime", "1.30.0");
        root.put("internetPermission", false);
        root.put("timestampMs", System.currentTimeMillis());
        return root;
    }

    private List<int[]> loadCases() throws Exception {
        JSONObject root = new JSONObject(readText(new File(packDir, "benchmark_inputs.json")));
        JSONArray cases = root.getJSONArray("cases");
        List<int[]> out = new ArrayList<>();
        for (int i = 0; i < cases.length(); i++) {
            JSONArray ids = cases.getJSONObject(i).getJSONArray("ids");
            int[] a = new int[ids.length()];
            for (int k = 0; k < a.length; k++) a[k] = ids.getInt(k);
            out.add(a);
        }
        if (out.isEmpty()) throw new IllegalStateException("no benchmark cases");
        return out;
    }

    private SynthesisResult synthesize(ModelSessions s, int[] ids, Random rng, boolean saveWav) throws Exception {
        long t0 = System.nanoTime();
        OrtEnvironment env = OrtEnvironment.getEnvironment();

        long[][] symbolIds = new long[1][ids.length];
        for (int i = 0; i < ids.length; i++) symbolIds[0][i] = ids[i];
        float[][] speaker = new float[][]{readSpeaker(new File(packDir, "speaker_embed.f32"))};
        float[][][] em1 = mask3(rng, ids.length, 256);
        float[][][] em2 = mask3(rng, ids.length, 256);

        Map<String, OnnxTensor> encIn = new LinkedHashMap<>();
        put(encIn, "symbol_ids", OnnxTensor.createTensor(env, symbolIds));
        put(encIn, "speaker_embed", OnnxTensor.createTensor(env, speaker));
        put(encIn, "enc_prenet_mask1", OnnxTensor.createTensor(env, em1));
        put(encIn, "enc_prenet_mask2", OnnxTensor.createTensor(env, em2));

        float[][][] encSeq;
        float[][][] encProj;
        try (OrtSession.Result rr = s.encoder.run(encIn)) {
            encSeq = value3(rr, "encoder_seq");
            encProj = value3(rr, "encoder_seq_proj");
        } finally {
            closeMap(encIn);
        }
        long encoderNs = System.nanoTime() - t0;

        float[][] charMask = new float[1][ids.length];
        Arrays.fill(charMask[0], 1f);
        float[][] prenet = new float[1][80];
        float[][] attnHidden = new float[1][128];
        float[][] r1h = new float[1][1024];
        float[][] r1c = new float[1][1024];
        float[][] r2h = new float[1][1024];
        float[][] r2c = new float[1][1024];
        float[][] context = new float[1][512];
        float[][] cumAttn = new float[1][ids.length];

        List<float[]> frames = new ArrayList<>();
        long decoderNs = 0L;
        int stopStep = -1;

        for (int step = 0; step < 1000; step++) {
            Map<String, OnnxTensor> in = new LinkedHashMap<>();
            put(in, "encoder_seq", OnnxTensor.createTensor(env, encSeq));
            put(in, "encoder_seq_proj", OnnxTensor.createTensor(env, encProj));
            put(in, "char_mask", OnnxTensor.createTensor(env, charMask));
            put(in, "prenet_in", OnnxTensor.createTensor(env, prenet));
            put(in, "attn_hidden", OnnxTensor.createTensor(env, attnHidden));
            put(in, "rnn1_hidden", OnnxTensor.createTensor(env, r1h));
            put(in, "rnn1_cell", OnnxTensor.createTensor(env, r1c));
            put(in, "rnn2_hidden", OnnxTensor.createTensor(env, r2h));
            put(in, "rnn2_cell", OnnxTensor.createTensor(env, r2c));
            put(in, "context_vec", OnnxTensor.createTensor(env, context));
            put(in, "cum_attn", OnnxTensor.createTensor(env, cumAttn));
            put(in, "prenet_mask1", OnnxTensor.createTensor(env, mask2(rng, 256)));
            put(in, "prenet_mask2", OnnxTensor.createTensor(env, mask2(rng, 256)));

            long td = System.nanoTime();
            try (OrtSession.Result rr = s.decoder.run(in)) {
                decoderNs += System.nanoTime() - td;
                float[][][] mel = value3(rr, "mel_frames");
                for (int r = 0; r < mel[0][0].length; r++) {
                    float[] f = new float[80];
                    for (int m = 0; m < 80; m++) f[m] = mel[0][m][r];
                    frames.add(f);
                }
                float[] last = frames.get(frames.size() - 1);
                prenet = new float[][]{Arrays.copyOf(last, last.length)};
                attnHidden = value2(rr, "attn_hidden_out");
                r1h = value2(rr, "rnn1_hidden_out");
                r1c = value2(rr, "rnn1_cell_out");
                r2h = value2(rr, "rnn2_hidden_out");
                r2c = value2(rr, "rnn2_cell_out");
                context = value2(rr, "context_vec_out");
                cumAttn = value2(rr, "cum_attn_out");
                float stop = value2(rr, "stop_token")[0][0];
                int frameIndex = step * 2;
                if (stop > 0.5f && frameIndex > 10) {
                    stopStep = step;
                    break;
                }
            } finally {
                closeMap(in);
            }
        }
        if (frames.isEmpty()) throw new IllegalStateException("decoder emitted no frames");

        int tMel = frames.size();
        float[][][] melSeq = new float[1][80][tMel];
        for (int t = 0; t < tMel; t++) {
            float[] f = frames.get(t);
            for (int m = 0; m < 80; m++) melSeq[0][m][t] = f[m];
        }

        Map<String, OnnxTensor> pIn = new LinkedHashMap<>();
        put(pIn, "mel_seq", OnnxTensor.createTensor(env, melSeq));
        long tp = System.nanoTime();
        float[][][] vocMel;
        try (OrtSession.Result rr = s.postnet.run(pIn)) {
            vocMel = value3(rr, "vocoder_mel");
        } finally {
            closeMap(pIn);
        }
        long postnetNs = System.nanoTime() - tp;

        int trimmed = vocMel[0][0].length;
        while (trimmed > 0) {
            float max = -Float.MAX_VALUE;
            for (int m = 0; m < 80; m++) max = Math.max(max, vocMel[0][m][trimmed - 1]);
            if (max < -3.4f) trimmed--;
            else break;
        }
        if (trimmed <= 0) throw new IllegalStateException("trim removed all mel frames");
        if (trimmed != vocMel[0][0].length) {
            float[][][] cut = new float[1][80][trimmed];
            for (int m = 0; m < 80; m++) {
                System.arraycopy(vocMel[0][m], 0, cut[0][m], 0, trimmed);
            }
            vocMel = cut;
        }

        Map<String, OnnxTensor> vIn = new LinkedHashMap<>();
        put(vIn, "mel", OnnxTensor.createTensor(env, vocMel));
        long tv = System.nanoTime();
        float[] wav;
        try (OrtSession.Result rr = s.vocoder.run(vIn)) {
            float[][][] w = value3(rr, "wav");
            wav = w[0][0];
        } finally {
            closeMap(vIn);
        }
        long vocoderNs = System.nanoTime() - tv;
        long totalNs = System.nanoTime() - t0;

        // Reference/demo gain path: peak-normalize to 0.97.
        float peak = 0f;
        for (float v : wav) peak = Math.max(peak, Math.abs(v));
        if (peak > 1e-9f) {
            float scale = 0.97f / peak;
            for (int i = 0; i < wav.length; i++) wav[i] *= scale;
        }

        File saved = null;
        if (saveWav) {
            File outDir = new File(getFilesDir(), "renders");
            if (!outDir.isDirectory() && !outDir.mkdirs()) throw new IllegalStateException("cannot create renders");
            saved = new File(outDir, "mana-" + System.currentTimeMillis() + ".wav");
            writeWav(saved, wav, 24000);
            lastWav = saved;
        }

        double audioSec = wav.length / 24000.0;
        SynthesisResult out = new SynthesisResult();
        out.symbols = ids.length;
        out.decoderSteps = stopStep >= 0 ? stopStep + 1 : frames.size() / 2;
        out.melFrames = trimmed;
        out.wavSamples = wav.length;
        out.encoderMs = encoderNs / 1e6;
        out.decoderMs = decoderNs / 1e6;
        out.postnetMs = postnetNs / 1e6;
        out.vocoderMs = vocoderNs / 1e6;
        out.totalMs = totalNs / 1e6;
        out.decoderMedianStepMsApprox = out.decoderMs / Math.max(1, out.decoderSteps);
        out.decoderRtf = (decoderNs / 1e9) / audioSec;
        out.vocoderRtf = (vocoderNs / 1e9) / audioSec;
        out.fullRtf = (totalNs / 1e9) / audioSec;
        out.ttfaMs = out.totalMs; // whole-utterance vocoder reference path
        out.postnetFraction = postnetNs / (double) Math.max(1L, totalNs);
        out.wavPath = saved == null ? "" : saved.getAbsolutePath();
        return out;
    }

    private static void put(Map<String, OnnxTensor> m, String k, OnnxTensor v) {
        m.put(k, v);
    }

    private static void closeMap(Map<String, OnnxTensor> m) {
        for (OnnxTensor t : m.values()) {
            try { t.close(); } catch (Throwable ignored) {}
        }
    }

    private static float[][][] value3(OrtSession.Result r, String name) throws OrtException {
        return (float[][][]) r.get(name).orElseThrow(() -> new IllegalStateException("missing output " + name)).getValue();
    }

    private static float[][] value2(OrtSession.Result r, String name) throws OrtException {
        return (float[][]) r.get(name).orElseThrow(() -> new IllegalStateException("missing output " + name)).getValue();
    }

    private static float[][][] mask3(Random r, int time, int width) {
        float[][][] a = new float[1][time][width];
        for (int t = 0; t < time; t++) for (int i = 0; i < width; i++) a[0][t][i] = r.nextBoolean() ? 2f : 0f;
        return a;
    }

    private static float[][] mask2(Random r, int width) {
        float[][] a = new float[1][width];
        for (int i = 0; i < width; i++) a[0][i] = r.nextBoolean() ? 2f : 0f;
        return a;
    }

    private static float[] readSpeaker(File f) throws Exception {
        byte[] b = readAll(new FileInputStream(f));
        if (b.length != 1024) throw new IllegalStateException("speaker_embed.f32 must be 1024 bytes");
        FloatBufferView v = new FloatBufferView(b);
        float[] out = new float[256];
        for (int i = 0; i < out.length; i++) out[i] = v.get(i);
        return out;
    }

    private static final class FloatBufferView {
        private final ByteBuffer b;
        FloatBufferView(byte[] raw) { b = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN); }
        float get(int i) { return b.getFloat(i * 4); }
    }

    private void playLast() {
        if (lastWav == null || !lastWav.isFile()) {
            log("No WAV yet.");
            return;
        }
        try {
            MediaPlayer p = new MediaPlayer();
            p.setDataSource(lastWav.getAbsolutePath());
            p.setOnCompletionListener(MediaPlayer::release);
            p.prepare();
            if (Build.VERSION.SDK_INT >= 23) {
                PlaybackParams params = p.getPlaybackParams();
                params.setSpeed(lastPlaybackSpeed);
                params.setPitch(1.0f);
                p.setPlaybackParams(params);
            }
            p.start();
            log("Playing: " + lastWav.getName() + " @ " + lastPlaybackSpeed + "x");
        } catch (Throwable t) {
            log("PLAY FAILED: " + t);
        }
    }

    private int thermalStatus() {
        if (Build.VERSION.SDK_INT < 29) return -1;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm == null ? -1 : pm.getCurrentThermalStatus();
    }

    private long rssKb() {
        Debug.MemoryInfo mi = new Debug.MemoryInfo();
        Debug.getMemoryInfo(mi);
        return mi.getTotalPss();
    }

    private static String readText(File f) throws Exception {
        return new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream x = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[1024 * 1024];
            int n;
            while ((n = x.read(b)) > 0) out.write(b, 0, n);
            return out.toByteArray();
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            byte[] b = new byte[1024 * 1024];
            int n;
            while ((n = in.read(b)) > 0) md.update(b, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte x : md.digest()) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }

    private static void writeWav(File out, float[] wav, int sr) throws Exception {
        int dataBytes = wav.length * 2;
        try (BufferedOutputStream o = new BufferedOutputStream(new FileOutputStream(out))) {
            writeAscii(o, "RIFF");
            writeLE32(o, 36 + dataBytes);
            writeAscii(o, "WAVEfmt ");
            writeLE32(o, 16);
            writeLE16(o, 1);
            writeLE16(o, 1);
            writeLE32(o, sr);
            writeLE32(o, sr * 2);
            writeLE16(o, 2);
            writeLE16(o, 16);
            writeAscii(o, "data");
            writeLE32(o, dataBytes);
            for (float v : wav) {
                int q = Math.max(-32768, Math.min(32767, Math.round(v * 32767f)));
                writeLE16(o, q & 0xffff);
            }
        }
    }

    private static void writeAscii(BufferedOutputStream o, String s) throws Exception {
        o.write(s.getBytes(StandardCharsets.US_ASCII));
    }

    private static void writeLE16(BufferedOutputStream o, int v) throws Exception {
        o.write(v & 255);
        o.write((v >>> 8) & 255);
    }

    private static void writeLE32(BufferedOutputStream o, int v) throws Exception {
        o.write(v & 255);
        o.write((v >>> 8) & 255);
        o.write((v >>> 16) & 255);
        o.write((v >>> 24) & 255);
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private void log(String s) {
        status.append((status.length() == 0 ? "" : "\n") + s);
    }

    private void logFromWorker(String s) {
        runOnUiThread(() -> log(s));
    }

    private static final class BenchmarkReport {
        final JSONObject json;
        BenchmarkReport(JSONObject j) { json = j; }
    }

    private static final class SynthesisResult {
        int symbols;
        int decoderSteps;
        int melFrames;
        int wavSamples;
        double encoderMs;
        double decoderMs;
        double postnetMs;
        double vocoderMs;
        double totalMs;
        double decoderMedianStepMsApprox;
        double decoderRtf;
        double vocoderRtf;
        double fullRtf;
        double ttfaMs;
        double postnetFraction;
        String wavPath;

        JSONObject toJson() throws Exception {
            JSONObject j = new JSONObject();
            j.put("symbols", symbols);
            j.put("decoderSteps", decoderSteps);
            j.put("melFrames", melFrames);
            j.put("wavSamples", wavSamples);
            j.put("encoderMs", encoderMs);
            j.put("decoderMs", decoderMs);
            j.put("decoderStepMsApprox", decoderMedianStepMsApprox);
            j.put("postnetMs", postnetMs);
            j.put("postnetFraction", postnetFraction);
            j.put("vocoderMs", vocoderMs);
            j.put("totalMs", totalMs);
            j.put("decoderRtf", decoderRtf);
            j.put("vocoderRtf", vocoderRtf);
            j.put("fullRtf", fullRtf);
            j.put("ttfaMsWholeUtterancePath", ttfaMs);
            j.put("wavPath", wavPath);
            return j;
        }
    }

    private static final class ModelSessions implements AutoCloseable {
        final OrtSession encoder;
        final OrtSession decoder;
        final OrtSession postnet;
        final OrtSession vocoder;
        final OrtSession.SessionOptions opts;

        private ModelSessions(OrtSession encoder, OrtSession decoder, OrtSession postnet, OrtSession vocoder, OrtSession.SessionOptions opts) {
            this.encoder = encoder;
            this.decoder = decoder;
            this.postnet = postnet;
            this.vocoder = vocoder;
            this.opts = opts;
        }

        static ModelSessions load(File dir, int threads) throws Exception {
            OrtEnvironment env = OrtEnvironment.getEnvironment();
            OrtSession.SessionOptions o = new OrtSession.SessionOptions();
            o.setIntraOpNumThreads(threads);
            o.setInterOpNumThreads(1);
            o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.NO_OPT);
            long start = System.nanoTime();
            OrtSession e = env.createSession(new File(dir, "tacotron_encoder.onnx").getAbsolutePath(), o);
            OrtSession d = env.createSession(new File(dir, "decoder_step.onnx").getAbsolutePath(), o);
            OrtSession p = env.createSession(new File(dir, "postnet.onnx").getAbsolutePath(), o);
            OrtSession v = env.createSession(new File(dir, "hifigan.onnx").getAbsolutePath(), o);
            double ms = (System.nanoTime() - start) / 1e6;
            return new ModelSessions(e, d, p, v, o);
        }

        @Override
        public void close() throws Exception {
            vocoder.close();
            postnet.close();
            decoder.close();
            encoder.close();
            opts.close();
        }
    }
}
