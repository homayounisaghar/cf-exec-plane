package com.mana.local.tacotron2.bench;

import java.util.ArrayList;
import java.util.List;

/**
 * Audition-only segmentation layer.
 *
 * It does not change the locked symbol table/model frontend. It only decides
 * where independently synthesized chunks are joined for owner listening tests.
 */
final class AuditionSegmenter {
    enum Boundary { NONE, WORD, PUNCTUATION, HARD_CHUNK }

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

    static List<Segment> segment(String normalized, boolean splitWords) {
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

                if (!splitWords) {
                    out.add(new Segment(chunk, tail));
                    continue;
                }

                String[] words = chunk.split(" +");
                for (int wi = 0; wi < words.length; wi++) {
                    String word = words[wi].trim();
                    if (word.isEmpty()) continue;
                    boolean lastWord = wi == words.length - 1;
                    out.add(new Segment(word, lastWord ? tail : Boundary.WORD));
                }
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
