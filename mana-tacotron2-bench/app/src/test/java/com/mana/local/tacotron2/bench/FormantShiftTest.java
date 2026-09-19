package com.mana.local.tacotron2.bench;

import org.junit.Test;
import static org.junit.Assert.*;

public class FormantShiftTest {
    @Test public void unityIsExactCopy() {
        float[] x = new float[]{0f, 0.25f, -0.5f, 0.75f, -0.1f};
        assertArrayEquals(x, FormantShift.process(x, 1.0f), 0.0f);
    }

    @Test public void shiftedOutputKeepsLengthAndFiniteSamples() {
        float[] x = new float[4800];
        for (int i = 0; i < x.length; i++) {
            double t = i / 24000.0;
            x[i] = (float) (0.35 * Math.sin(2.0 * Math.PI * 180.0 * t)
                    + 0.20 * Math.sin(2.0 * Math.PI * 900.0 * t)
                    + 0.12 * Math.sin(2.0 * Math.PI * 2300.0 * t));
        }
        float[] y = FormantShift.process(x, 0.85f);
        assertEquals(x.length, y.length);
        double diff = 0.0;
        for (int i = 0; i < y.length; i++) {
            assertTrue(Float.isFinite(y[i]));
            assertTrue(Math.abs(y[i]) <= 1.001f);
            diff += Math.abs(x[i] - y[i]);
        }
        assertTrue("formant filter should alter nontrivial audio", diff > 1.0);
    }

    @Test public void requestedRatioIsClampedSafely() {
        float[] x = new float[2048];
        x[512] = 0.5f;
        float[] y = FormantShift.process(x, 0.2f);
        assertEquals(x.length, y.length);
        for (float v : y) assertTrue(Float.isFinite(v));
    }
}
