package com.homayounisaghar.dexasuperdashboard;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class Telemetry {
    static final String ENDPOINT = "https://dexa-super-dashboard-20261105.onrender.com/api/telemetry";
    private static final String QUEUE = "pending_events";
    private final SharedPreferences preferences;
    private final ExecutorService uploader = Executors.newSingleThreadExecutor();
    private final AtomicBoolean uploading = new AtomicBoolean(false);
    private final String device;
    private final String session = UUID.randomUUID().toString().substring(0, 12);
    private volatile int lastHttp = 0;
    private volatile long lastAckMs = 0L;

    Telemetry(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences("dexa_super_telemetry_v1", Context.MODE_PRIVATE);
        String stored = preferences.getString("device", null);
        if (stored == null) {
            stored = UUID.randomUUID().toString();
            preferences.edit().putString("device", stored).commit();
        }
        device = stored;
        lastAckMs = preferences.getLong("last_ack_ms", 0L);
        flushAsync();
    }

    synchronized void record(String event, int slot, JSONObject detail) {
        try {
            JSONObject e = new JSONObject();
            e.put("id", UUID.randomUUID().toString().substring(0, 16));
            e.put("device", device);
            e.put("session", session);
            e.put("build", 1);
            e.put("time", System.currentTimeMillis());
            e.put("event", event);
            e.put("slot", slot);
            if (detail != null) {
                String[] keys = {"code", "host", "visible", "count", "phase", "ok", "durationMs"};
                for (String key : keys) {
                    if (detail.has(key) && !detail.isNull(key)) {
                        Object value = detail.get(key);
                        if (value instanceof String) value = ((String) value).substring(0, Math.min(95, ((String) value).length()));
                        e.put(key, value);
                    }
                }
            }
            JSONArray old = queue();
            JSONArray out = new JSONArray();
            for (int i = Math.max(0, old.length() - 248); i < old.length(); i++) out.put(old.opt(i));
            out.put(e);
            preferences.edit().putString(QUEUE, out.toString()).commit();
        } catch (Exception ignored) {}
        flushAsync();
    }

    private synchronized JSONArray queue() {
        try { return new JSONArray(preferences.getString(QUEUE, "[]")); }
        catch (Exception ignored) { return new JSONArray(); }
    }

    synchronized int pending() { return queue().length(); }
    int lastHttp() { return lastHttp; }
    long lastAckMs() { return lastAckMs; }
    String deviceShort() { return device.substring(0, 8); }

    void flushAsync() {
        if (!uploading.compareAndSet(false, true)) return;
        uploader.execute(() -> {
            try {
                for (int i = 0; i < 260; i++) {
                    JSONObject item;
                    synchronized (this) {
                        JSONArray q = queue();
                        if (q.length() == 0) break;
                        item = q.optJSONObject(0);
                    }
                    if (item == null) break;
                    int code = post(item);
                    lastHttp = code;
                    if (code != 202) break;
                    synchronized (this) {
                        JSONArray q = queue(), after = new JSONArray();
                        String delivered = item.optString("id");
                        boolean removed = false;
                        for (int j = 0; j < q.length(); j++) {
                            JSONObject candidate = q.optJSONObject(j);
                            if (!removed && candidate != null && delivered.equals(candidate.optString("id"))) {removed = true; continue;}
                            after.put(q.opt(j));
                        }
                        lastAckMs = System.currentTimeMillis();
                        preferences.edit().putString(QUEUE, after.toString()).putLong("last_ack_ms", lastAckMs).commit();
                    }
                }
            } finally { uploading.set(false); }
        });
    }

    private static int post(JSONObject e) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            c.setConnectTimeout(4500);
            c.setReadTimeout(4500);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = e.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream stream = c.getOutputStream()) { stream.write(bytes); }
            return c.getResponseCode();
        } catch (Exception ignored) { return -1; }
        finally { if (c != null) c.disconnect(); }
    }

    static JSONObject meta(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]); }
        catch (Exception ignored) {}
        return o;
    }
}
