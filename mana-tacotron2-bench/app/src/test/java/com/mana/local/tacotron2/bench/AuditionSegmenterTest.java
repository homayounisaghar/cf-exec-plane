package com.mana.local.tacotron2.bench;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class AuditionSegmenterTest {
    @Test public void commaCreatesRealSpeechBoundary() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام، دنیا");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n);
        assertEquals(2, s.size());
        assertEquals("سلام،", s.get(0).text);
        assertEquals(AuditionSegmenter.Boundary.PUNCTUATION, s.get(0).boundaryAfter);
        assertEquals("دنیا", s.get(1).text);
        assertEquals(AuditionSegmenter.Boundary.NONE, s.get(1).boundaryAfter);
    }

    @Test public void ordinaryWordsRemainOneInferenceSegment() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام دنیا حالت خوبه");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n);
        assertEquals(1, s.size());
        assertEquals("سلام دنیا حالت خوبه", s.get(0).text);
        assertEquals(AuditionSegmenter.Boundary.NONE, s.get(0).boundaryAfter);
    }

    @Test public void punctuationStillCreatesPhraseSegments() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام دنیا؟ بعدش خوبه");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n);
        assertEquals(2, s.size());
        assertEquals("سلام دنیا؟", s.get(0).text);
        assertEquals(AuditionSegmenter.Boundary.PUNCTUATION, s.get(0).boundaryAfter);
        assertEquals("بعدش خوبه", s.get(1).text);
    }

    @Test public void consecutivePunctuationStaysWithPhrase() {
        String n = PersianFrontend.normalizeTextForSynthesis("سلام... دنیا");
        List<AuditionSegmenter.Segment> s = AuditionSegmenter.segment(n);
        assertEquals(2, s.size());
        assertEquals("سلام...", s.get(0).text);
        assertEquals("دنیا", s.get(1).text);
    }
}
