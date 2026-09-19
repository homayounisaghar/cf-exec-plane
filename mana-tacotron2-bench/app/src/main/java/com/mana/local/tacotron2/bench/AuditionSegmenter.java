package com.mana.local.tacotron2.bench;

import java.util.ArrayList;
import java.util.List;

/**
 * Audition-only phrase segmentation.
 * Ordinary words are never split into separate Tacotron inference jobs.
 * Punctuation/long-text safety chunks may be independent, while adjustable
 * word gaps are inserted after rendering using decoder attention.
 */
final class AuditionSegmenter {
    enum Boundary { NONE, PUNCTUATION, HARD_CHUNK }

    static final class Segment {
        final String text;
        final Boundary boundaryAfter;

        Segment(String text, Boundary boundaryAfter) {
            this.text = text;
            this.boundaryAfter = boundaryAfter;
        }
    }

    private static final class Phrase {
        final String text;
        final boolean punctuationBoundary;

        Phrase(String text, boolean punctuationBoundary) {
            this.text = text;
            this.punctuationBoundary = punctuationBoundary;
        }
    }

    static List<Segment> segment(String normalized) {
        List<Segment> out = new ArrayList<>();
        for (Phrase phrase : splitAtPunctuation(normalized)) {
            List<String> bounded = PersianFrontend.splitNormalized(phrase.text);
            for (int ci = 0; ci < bounded.size(); ci++) {
                String chunk = bounded.get(ci).trim();
                if (chunk.isEmpty()) continue;
                boolean lastChunk = ci == bounded.size() - 1;
                Boundary tail = lastChunk
                        ? (phrase.punctuationBoundary ? Boundary.PUNCTUATION : Boundary.NONE)
                        : Boundary.HARD_CHUNK;
                out.add(new Segment(chunk, tail));
            }
        }
        return out;
    }

    private static List<Phrase> splitAtPunctuation(String text) {
        List<Phrase> out = new ArrayList<>();
        String s = text == null ? "" : text.trim();
        if (s.isEmpty()) return out;

        StringBuilder current = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            current.append(c);
            if (isBoundaryPunctuation(c)) {
                while (i + 1 < s.length() && isBoundaryPunctuation(s.charAt(i + 1))) {
                    current.append(s.charAt(++i));
                }
                String piece = current.toString().trim();
                if (!piece.isEmpty()) out.add(new Phrase(piece, true));
                current.setLength(0);
            }
        }

        String tail = current.toString().trim();
        if (!tail.isEmpty()) out.add(new Phrase(tail, false));
        return out;
    }

    private static boolean isBoundaryPunctuation(char c) {
        return c == '،' || c == ',' ||
                c == '؛' || c == ';' ||
                c == '.' || c == ':' ||
                c == '!' || c == '?' || c == '؟' ||
                c == '…';
    }

    private AuditionSegmenter() {}
}
