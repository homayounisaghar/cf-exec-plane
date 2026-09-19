package com.mana.local.tacotron2.bench;

import org.junit.Test;
import java.util.Arrays;
import static org.junit.Assert.*;

public class PersianFrontendTest {
    private static void assertIds(String input, int... expected) {
        String n = PersianFrontend.normalizeTextForSynthesis(input);
        assertEquals(1, PersianFrontend.splitNormalized(n).size());
        PersianFrontend.Encoded e = PersianFrontend.encodeOovGuard(PersianFrontend.splitNormalized(n).get(0));
        assertArrayEquals(expected, e.ids);
    }

    @Test public void canonicalHello() {
        assertIds("سلام دنیا.", 14,24,3,25,58,10,26,36,3,53);
    }

    @Test public void canonicalNumber123() {
        assertIds("عدد ۱۲۳ را بخوان.",
                20,10,10,58,16,45,10,58,28,58,4,36,14,5,58,28,58,14,27,58,12,3,58,4,9,28,3,26,53);
    }

    @Test public void canonicalQuestion() {
        assertIds("این یک پرسش است؟", 3,36,26,58,36,34,58,31,12,14,15,58,3,14,5,63);
    }

    @Test public void oovGuardDropsQuotesWithoutCollapsing() {
        String n = PersianFrontend.normalizeTextForSynthesis("«سلام دنیا»");
        PersianFrontend.Encoded e = PersianFrontend.encodeOovGuard(PersianFrontend.splitNormalized(n).get(0));
        assertEquals("سلام دنیا", e.filtered);
        assertEquals(Arrays.asList("U+00AB", "U+00BB"), e.dropped);
    }
}
