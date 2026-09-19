package com.mana.local.tacotron2.bench;

import org.junit.Test;
import java.util.Arrays;
import java.util.List;
import static org.junit.Assert.*;

public class WordGapPostProcessorTest {
    @Test public void zeroGapIsLengthPreservingBypass() {
        float[] wav = new float[2400];
        int[] ids = new int[]{14, 24, 58, 10, 26};
        List<Float> centers = Arrays.asList(0f, 1f, 2f, 3f);
        WordGapPostProcessor.Result r =
                WordGapPostProcessor.insertByAttention(wav, ids, centers, 0);
        assertEquals(wav.length, r.audio.length);
        assertEquals(0, r.insertedBoundaries);
    }

    @Test public void oneSpaceAddsRequestedSilence() {
        float[] wav = new float[12000];
        for (int i = 0; i < wav.length; i++) wav[i] = 0.2f;
        int[] ids = new int[]{14, 24, 3, 25, 58, 10, 26, 36, 3};
        List<Float> centers = Arrays.asList(0f, 1f, 2f, 3f, 4f, 5f, 6f, 7f);
        WordGapPostProcessor.Result r =
                WordGapPostProcessor.insertByAttention(wav, ids, centers, 100);
        assertEquals(wav.length + 2400, r.audio.length);
        assertEquals(1, r.insertedBoundaries);
    }

    @Test public void multipleSpacesAddOneGapEach() {
        float[] wav = new float[24000];
        int[] ids = new int[]{1, 2, 58, 3, 4, 58, 5, 6};
        List<Float> centers = Arrays.asList(0f, 1f, 2f, 3f, 4f, 5f, 6f);
        WordGapPostProcessor.Result r =
                WordGapPostProcessor.insertByAttention(wav, ids, centers, 50);
        assertEquals(2, r.insertedBoundaries);
        assertEquals(wav.length + 2400, r.audio.length);
    }

    @Test public void gapIsClampedToFourHundredMs() {
        float[] wav = new float[12000];
        int[] ids = new int[]{1, 58, 2};
        List<Float> centers = Arrays.asList(0f, 1f, 2f);
        WordGapPostProcessor.Result r =
                WordGapPostProcessor.insertByAttention(wav, ids, centers, 9999);
        assertEquals(wav.length + 9600, r.audio.length);
    }
}
