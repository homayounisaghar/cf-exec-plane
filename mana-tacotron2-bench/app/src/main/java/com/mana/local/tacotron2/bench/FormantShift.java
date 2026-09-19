package com.mana.local.tacotron2.bench;

import java.util.Arrays;

/**
 * Lightweight audition-only formant shifter.
 *
 * Frames audio with a Hann window, estimates a smoothed log spectral envelope,
 * frequency-warps only that envelope, preserves the fine harmonic structure and
 * phase, then overlap-adds back to PCM. This is deliberately a simple local
 * filter, not a speaker model or production-quality voice conversion system.
 */
final class FormantShift {
    private static final int N = 1024;
    private static final int HOP = 256;
    private static final int HALF = N / 2;
    private static final int SMOOTH_RADIUS = 12;

    static float[] process(float[] input, float requestedRatio) {
        if (input == null) throw new IllegalArgumentException("input == null");
        if (input.length == 0) return new float[0];

        float ratio = Math.max(0.75f, Math.min(1.15f, requestedRatio));
        if (Math.abs(ratio - 1.0f) < 0.005f) return Arrays.copyOf(input, input.length);

        int pad = N / 2;
        int paddedLen = input.length + (pad * 2);
        double[] padded = new double[paddedLen];
        for (int i = 0; i < input.length; i++) padded[i + pad] = input[i];

        double[] output = new double[paddedLen + N];
        double[] norm = new double[paddedLen + N];
        double[] window = new double[N];
        for (int i = 0; i < N; i++) {
            window[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / (N - 1));
        }

        double[] re = new double[N];
        double[] im = new double[N];
        double[] logMag = new double[HALF + 1];
        double[] smooth = new double[HALF + 1];
        double[] prefix = new double[HALF + 2];

        for (int start = 0; start + N <= padded.length; start += HOP) {
            for (int i = 0; i < N; i++) {
                re[i] = padded[start + i] * window[i];
                im[i] = 0.0;
            }

            fft(re, im, false);

            for (int k = 0; k <= HALF; k++) {
                double mag = Math.hypot(re[k], im[k]);
                logMag[k] = Math.log(mag + 1e-8);
            }

            prefix[0] = 0.0;
            for (int k = 0; k <= HALF; k++) prefix[k + 1] = prefix[k] + logMag[k];
            for (int k = 0; k <= HALF; k++) {
                int a = Math.max(0, k - SMOOTH_RADIUS);
                int b = Math.min(HALF, k + SMOOTH_RADIUS);
                smooth[k] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
            }

            for (int k = 0; k <= HALF; k++) {
                double src = k / (double) ratio;
                double desired = interpolate(smooth, src);
                double gain = Math.exp(desired - smooth[k]);

                // Keep the simple filter stable and fade its effect near Nyquist.
                gain = Math.max(0.45, Math.min(2.20, gain));
                double hz = (k * 24000.0) / N;
                double effect;
                if (hz <= 7000.0) effect = 1.0;
                else if (hz >= 11000.0) effect = 0.0;
                else effect = (11000.0 - hz) / 4000.0;
                gain = 1.0 + ((gain - 1.0) * effect);

                re[k] *= gain;
                im[k] *= gain;
                if (k > 0 && k < HALF) {
                    int mirror = N - k;
                    re[mirror] *= gain;
                    im[mirror] *= gain;
                }
            }

            fft(re, im, true);

            for (int i = 0; i < N; i++) {
                double w = window[i];
                output[start + i] += re[i] * w;
                norm[start + i] += w * w;
            }
        }

        float[] result = new float[input.length];
        double peak = 0.0;
        for (int i = 0; i < input.length; i++) {
            int p = i + pad;
            double v = norm[p] > 1e-9 ? output[p] / norm[p] : 0.0;
            if (!Double.isFinite(v)) v = 0.0;
            result[i] = (float) v;
            peak = Math.max(peak, Math.abs(v));
        }

        // Never amplify quiet material just because it passed through the filter.
        if (peak > 0.98) {
            float scale = (float) (0.98 / peak);
            for (int i = 0; i < result.length; i++) result[i] *= scale;
        }
        return result;
    }

    private static double interpolate(double[] a, double x) {
        if (x <= 0.0) return a[0];
        if (x >= a.length - 1) return a[a.length - 1];
        int i = (int) Math.floor(x);
        double t = x - i;
        return a[i] + ((a[i + 1] - a[i]) * t);
    }

    private static void fft(double[] re, double[] im, boolean inverse) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            while ((j & bit) != 0) {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if (i < j) {
                double tr = re[i]; re[i] = re[j]; re[j] = tr;
                double ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }

        for (int len = 2; len <= n; len <<= 1) {
            double angle = (inverse ? 2.0 : -2.0) * Math.PI / len;
            double wLenR = Math.cos(angle);
            double wLenI = Math.sin(angle);
            for (int i = 0; i < n; i += len) {
                double wr = 1.0;
                double wi = 0.0;
                int half = len >> 1;
                for (int j = 0; j < half; j++) {
                    int u = i + j;
                    int v = u + half;
                    double vr = (re[v] * wr) - (im[v] * wi);
                    double vi = (re[v] * wi) + (im[v] * wr);

                    re[v] = re[u] - vr;
                    im[v] = im[u] - vi;
                    re[u] += vr;
                    im[u] += vi;

                    double nextWr = (wr * wLenR) - (wi * wLenI);
                    wi = (wr * wLenI) + (wi * wLenR);
                    wr = nextWr;
                }
            }
        }

        if (inverse) {
            for (int i = 0; i < n; i++) {
                re[i] /= n;
                im[i] /= n;
            }
        }
    }

    private FormantShift() {}
}
