package com.mana.local.tacotron2.bench;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Adds extra silence at textual spaces without re-running Tacotron per word.
 * Decoder attention maps text positions to decoder steps; accepted spaces
 * become cuts in the already-rendered waveform.
 */
final class WordGapPostProcessor {
    private static final int SPACE_ID = 58;
    private static final int SAMPLE_RATE = 24000;
    private static final int REDUCTION = 2;
    private static final int MEL_HOP = 300;
    private static final int FADE_SAMPLES = 96;

    static final class Result {
        final float[] audio;
        final int insertedBoundaries;
        final int skippedBoundaries;

        Result(float[] audio, int insertedBoundaries, int skippedBoundaries) {
            this.audio = audio;
            this.insertedBoundaries = insertedBoundaries;
            this.skippedBoundaries = skippedBoundaries;
        }
    }

    static Result insertByAttention(float[] wav, int[] ids, List<Float> centers, int requestedGapMs) {
        if (wav == null) throw new IllegalArgumentException("wav == null");
        if (ids == null) throw new IllegalArgumentException("ids == null");
        if (centers == null) throw new IllegalArgumentException("centers == null");

        int gapMs = Math.max(0, Math.min(400, requestedGapMs));
        if (gapMs == 0 || wav.length == 0 || ids.length < 3 || centers.isEmpty()) {
            return new Result(Arrays.copyOf(wav, wav.length), 0, 0);
        }

        List<Integer> cuts = new ArrayList<>();
        int skipped = 0;
        int previous = -1;

        for (int i = 1; i < ids.length - 1; i++) {
            if (ids[i] != SPACE_ID) continue;

            int step = findCrossingStep(centers, i + 0.5f);
            int sample = step >= 0
                    ? (step + 1) * REDUCTION * MEL_HOP
                    : Math.round(((i + 0.5f) / ids.length) * wav.length);

            sample = Math.max(FADE_SAMPLES, Math.min(wav.length - FADE_SAMPLES, sample));
            if (sample <= FADE_SAMPLES || sample >= wav.length - FADE_SAMPLES) {
                skipped++;
                continue;
            }
            if (previous >= 0 && sample - previous < (MEL_HOP * REDUCTION)) {
                skipped++;
                continue;
            }

            cuts.add(sample);
            previous = sample;
        }

        if (cuts.isEmpty()) {
            return new Result(Arrays.copyOf(wav, wav.length), 0, skipped);
        }

        float[] src = Arrays.copyOf(wav, wav.length);
        for (int cut : cuts) {
            for (int k = 0; k < FADE_SAMPLES; k++) {
                float outGain = (FADE_SAMPLES - 1 - k) / (float) FADE_SAMPLES;
                float inGain = (k + 1) / (float) FADE_SAMPLES;
                src[cut - FADE_SAMPLES + k] *= outGain;
                src[cut + k] *= inGain;
            }
        }

        int gapSamples = (SAMPLE_RATE * gapMs) / 1000;
        long total = (long) src.length + ((long) gapSamples * cuts.size());
        if (total > Integer.MAX_VALUE) throw new IllegalStateException("word-gap output too large");

        float[] out = new float[(int) total];
        int inPos = 0;
        int outPos = 0;
        for (int cut : cuts) {
            int n = cut - inPos;
            System.arraycopy(src, inPos, out, outPos, n);
            inPos = cut;
            outPos += n + gapSamples;
        }
        System.arraycopy(src, inPos, out, outPos, src.length - inPos);

        return new Result(out, cuts.size(), skipped);
    }

    private static int findCrossingStep(List<Float> centers, float target) {
        float prev = centers.get(0);
        if (Float.isFinite(prev) && prev >= target) return 0;

        for (int i = 1; i < centers.size(); i++) {
            float cur = centers.get(i);
            if (Float.isFinite(cur) && cur >= target && (!Float.isFinite(prev) || prev < target)) {
                return i;
            }
            if (Float.isFinite(cur)) prev = cur;
        }

        for (int i = 0; i < centers.size(); i++) {
            float cur = centers.get(i);
            if (Float.isFinite(cur) && cur >= target) return i;
        }
        return -1;
    }

    private WordGapPostProcessor() {}
}
