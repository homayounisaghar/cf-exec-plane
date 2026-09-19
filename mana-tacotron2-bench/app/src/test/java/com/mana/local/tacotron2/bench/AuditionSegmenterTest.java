package com.mana.local.tacotron2.bench;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class AuditionSegmenterTest {
    @Test public void commaCreatesRealSpeechBoundary() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام، دنیا");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n, false);
        assertEquals(2, s.size());
        assertEquals("سلام،", s.get(0).text);
        assertEquals(AuditionSegmenter.Boundary.PUNCTUATION, s.get(0).boundaryAfter);
        assertEquals("دنیا", s.get(1).text);
        assertEquals(AuditionSegmenter.Boundary.NONE, s.get(1).boundaryAfter);
    }

    @Test public void wordGapModeCreatesWordBoundaries() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام دنیا");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n, true);
        assertEquals(2, s.size());
        assertEquals("سلام", s.get(0).text);
        assertEquals(AuditionSegmenter.Boundary.WORD, s.get(0).boundaryAfter);
        assertEquals("دنیا", s.get(1).text);
        assertEquals(AuditionSegmenter.Boundary.NONE, s.get(1).boundaryAfter);
    }

    @Test public void punctuationWinsAfterLastWord() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام دنیا؟ بعد");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n, true);
        assertEquals(3, s.size());
        assertEquals(AuditionSegmenter.Boundary.WORD, s.get(0).boundaryAfter);
        assertEquals(AuditionSegmenter.Boundary.PUNCTUATION, s.get(1).boundaryAfter);
        assertEquals(AuditionSegmenter.Boundary.NONE, s.get(2).boundaryAfter);
    }

    @Test public void consecutivePunctuationStaysWithPhrase() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام... دنیا");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n, false);
        assertEquals(2, s.size());
        assertEquals("سلام...", s.get(0).text);
        assertEquals("دنیا", s.get(1).text);
    }
}
