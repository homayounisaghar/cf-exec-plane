package com.mana.local.tacotron2.bench;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android port of the locked Mana reference text frontend.
 * Symbol ordering matches the canonical 126-symbol checkpoint table.
 */
final class PersianFrontend {
    private static final String CHARACTERS =
            "ءابتثجحخدذرزسشصضطظعغفقلمنهويِپچژکگیآۀةأؤإئًَُّ!(),-.:;?  ̠،…؛؟‌٪#üABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_–@+/\u200c";
    private static final Map<Character, Integer> SYMBOL_TO_ID = new LinkedHashMap<>();
    private static final Pattern NUMBER_PATTERN = Pattern.compile("(?:\\+|-)?\\d+(?:[,\\-]\\d+)*");

    static {
        String symbols = "_~" + CHARACTERS;
        for (int i = 0; i < symbols.length(); i++) {
            // Intentional last-write-wins: the locked table contains duplicate space,
            // underscore and ZWNJ entries and the Python dict comprehension does the same.
            SYMBOL_TO_ID.put(symbols.charAt(i), i);
        }
        if (SYMBOL_TO_ID.size() >= 126) {
            throw new IllegalStateException("unexpected symbol uniqueness");
        }
        requireId('ا', 3);
        requireId('ظ', 19);
        requireId('ی', 36);
        requireId('َ', 45);
        requireId(' ', 58);
        requireId('،', 60);
        requireId('؟', 63);
        requireId('٪', 65);
        requireId('A', 68);
        requireId('a', 94);
        requireId('‌', 125);
    }

    private static void requireId(char c, int expected) {
        Integer actual = SYMBOL_TO_ID.get(c);
        if (actual == null || actual != expected) {
            throw new IllegalStateException("symbol table mismatch for U+" +
                    String.format(Locale.ROOT, "%04X", (int) c) + ": " + actual + " != " + expected);
        }
    }

    static final class Encoded {
        final String input;
        final String filtered;
        final int[] ids;
        final List<String> dropped;

        Encoded(String input, String filtered, int[] ids, List<String> dropped) {
            this.input = input;
            this.filtered = filtered;
            this.ids = ids;
            this.dropped = dropped;
        }
    }

    static String normalizeTextForSynthesis(String text) {
        String s = text == null ? "" : text;
        s = s.replace('ك', 'ک').replace('ي', 'ی');
        s = s.replace('_', '‌');
        s = s.replaceAll("\\s+", " ").trim();
        s = normalizeDigits(s);
        return findAndNormalizeNumbers(s);
    }

    static List<String> splitNormalized(String normalized) {
        String text = cleanText(normalized);
        List<String> out = new ArrayList<>();
        if (text.isEmpty()) return out;
        if (text.length() <= 200) {
            out.add(text);
            return out;
        }

        List<String> sentences = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            current.append(c);
            if (c == '.' || c == '!' || c == '?' || c == '؟' || c == '۔') {
                String x = current.toString().trim();
                if (!x.isEmpty()) sentences.add(x);
                current.setLength(0);
            }
        }
        String tail = current.toString().trim();
        if (!tail.isEmpty()) sentences.add(tail);

        for (String sentence : sentences) {
            if (sentence.length() <= 200) out.add(sentence);
            else out.addAll(splitLongSentence(sentence));
        }
        return out;
    }

    private static List<String> splitLongSentence(String sentence) {
        List<String> chunks = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < sentence.length(); i++) {
            char c = sentence.charAt(i);
            current.append(c);
            boolean weak = c == '،' || c == ',' || c == ';' || c == '؛';
            if (weak && current.length() >= 50) {
                String x = current.toString().trim();
                if (!x.isEmpty()) chunks.add(x);
                current.setLength(0);
            } else if (current.length() >= 200) {
                int cut = current.lastIndexOf(" ");
                if (cut < 1) cut = current.length();
                String x = current.substring(0, cut).trim();
                if (!x.isEmpty()) chunks.add(x);
                String rest = current.substring(cut).trim();
                current.setLength(0);
                current.append(rest);
            }
        }
        String x = current.toString().trim();
        if (!x.isEmpty()) chunks.add(x);

        List<String> finalChunks = new ArrayList<>();
        for (String c : chunks) {
            if (c.length() <= 200) finalChunks.add(c);
            else finalChunks.addAll(forceSplitByWords(c));
        }
        return finalChunks;
    }

    private static List<String> forceSplitByWords(String text) {
        List<String> out = new ArrayList<>();
        String[] words = text.split(" ");
        StringBuilder b = new StringBuilder();
        for (String w : words) {
            if (w.isEmpty()) continue;
            int next = b.length() + (b.length() == 0 ? 0 : 1) + w.length();
            if (next > 200 && b.length() > 0) {
                out.add(b.toString());
                b.setLength(0);
            }
            if (b.length() > 0) b.append(' ');
            b.append(w);
        }
        if (b.length() > 0) out.add(b.toString());
        return out;
    }

    static Encoded encodeOovGuard(String segment) {
        String s = segment == null ? "" : segment.trim();
        List<Integer> ids = new ArrayList<>();
        List<String> dropped = new ArrayList<>();
        StringBuilder filtered = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            Integer id = SYMBOL_TO_ID.get(c);
            if (id == null) {
                dropped.add(String.format(Locale.ROOT, "U+%04X", (int) c));
            } else {
                filtered.append(c);
                ids.add(id);
            }
        }
        int[] a = new int[ids.size()];
        for (int i = 0; i < a.length; i++) a[i] = ids.get(i);
        return new Encoded(s, filtered.toString(), a, dropped);
    }

    private static String cleanText(String text) {
        String s = text.replaceAll("\\s+", " ");
        s = s.replace('_', '‌');
        s = s.replace('ك', 'ک').replace('ي', 'ی');
        s = normalizeDigits(s);
        return s.trim();
    }

    private static String normalizeDigits(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int p = "۰۱۲۳۴۵۶۷۸۹".indexOf(c);
            if (p >= 0) c = (char) ('0' + p);
            else {
                int a = "٠١٢٣٤٥٦٧٨٩".indexOf(c);
                if (a >= 0) c = (char) ('0' + a);
            }
            b.append(c);
        }
        return b.toString();
    }

    private static String findAndNormalizeNumbers(String text) {
        Matcher m = NUMBER_PATTERN.matcher(text);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String original = m.group();
            String clean = original.replace(",", "");
            String replacement = original;
            if (isLikelyPhone(clean)) {
                replacement = phoneToText(clean);
            } else {
                try {
                    replacement = numToText(Long.parseLong(clean));
                } catch (NumberFormatException ignored) {
                }
            }
            m.appendReplacement(out, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(out);
        return out.toString();
    }

    private static String numToText(long num) {
        if (num == 0) return "صِفر";
        if (num < 0) return "مَنفی " + numToText(-num);
        if (num < 1000) return convertThreeDigit((int) num);

        List<String> parts = new ArrayList<>();
        if (num >= 1_000_000_000L) {
            long billions = num / 1_000_000_000L;
            parts.add(convertThreeDigit((int) Math.min(billions, 999)) + " میلیارد");
            num %= 1_000_000_000L;
        }
        if (num >= 1_000_000L) {
            int millions = (int) (num / 1_000_000L);
            parts.add(convertThreeDigit(millions) + " میلیون");
            num %= 1_000_000L;
        }
        if (num >= 1000L) {
            int thousands = (int) (num / 1000L);
            parts.add(convertThreeDigit(thousands) + " هزار");
            num %= 1000L;
        }
        if (num > 0) parts.add(convertThreeDigit((int) num));
        return joinVa(parts);
    }

    private static String convertThreeDigit(int num) {
        final String[] ones = {"صِفر", "یک", "دو", "سه", "چهار", "پنج", "شِش", "هفت", "هشت", "نُه"};
        final String[] teens = {"دَه", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"};
        final String[] tens = {"", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"};
        final String[] hundreds = {"", "صَد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"};
        if (num == 0) return "";
        if (num < 10) return ones[num];
        if (num < 20) return teens[num - 10];
        if (num < 100) {
            int t = num / 10, o = num % 10;
            return o == 0 ? tens[t] : tens[t] + " و " + ones[o];
        }
        int h = num / 100, rem = num % 100;
        return rem == 0 ? hundreds[h] : hundreds[h] + " و " + convertThreeDigit(rem);
    }

    private static boolean isLikelyPhone(String s) {
        if (s.startsWith("+")) return true;
        if (s.startsWith("09") && s.length() == 11) return true;
        return s.startsWith("0") && s.length() >= 7;
    }

    private static String phoneToText(String raw) {
        String s = raw.replace(" ", "").replace("-", "").replace("(", "").replace(")", "");
        boolean plus = s.startsWith("+");
        if (plus) s = s.substring(1);
        if (!s.matches("\\d+")) return raw;

        List<String> chunks = smartSplitPhone(s, plus);
        List<String> text = new ArrayList<>();
        for (String c : chunks) {
            if (c.startsWith("+")) text.add("مثبت " + numToText(Long.parseLong(c.substring(1))));
            else text.add(readPhoneChunk(c));
        }
        return joinComma(text);
    }

    private static List<String> smartSplitPhone(String phone, boolean plus) {
        int length = phone.length();
        List<String> chunks = new ArrayList<>();
        if (plus) {
            if (phone.startsWith("98") && length > 5) {
                chunks.add("+" + phone.substring(0, 2));
                String rest = phone.substring(2);
                if (rest.startsWith("9")) {
                    chunks.addAll(smartSplitPhone("0" + rest, false));
                    return chunks;
                }
                chunks.add(rest);
                return chunks;
            } else if (phone.startsWith("1") && length == 11) {
                chunks.add("+" + phone.substring(0, 1));
                chunks.add(phone.substring(1, 4));
                chunks.add(phone.substring(4, 7));
                chunks.add(phone.substring(7));
                return chunks;
            }
        }
        if (phone.startsWith("09") && length == 11) {
            chunks.add(phone.substring(0, 4));
            String rest = phone.substring(4);
            String mid = rest.substring(0, 3);
            String end = rest.substring(3);
            boolean round = end.equals("0000") || end.endsWith("00") ||
                    (end.length() >= 3 && end.charAt(1) == '0' && end.charAt(2) == '0') ||
                    mid.equals("000");
            chunks.add(mid);
            if (round) chunks.add(end);
            else {
                chunks.add(rest.substring(3, 5));
                chunks.add(rest.substring(5));
            }
            return chunks;
        }
        if (phone.startsWith("0") && length == 11) {
            chunks.add(phone.substring(0, 3));
            String rest = phone.substring(3);
            String p1 = rest.substring(0, 4), p2 = rest.substring(4);
            if ((p1.endsWith("00") && p2.endsWith("00")) || p2.equals("0000")) {
                chunks.add(p1); chunks.add(p2); return chunks;
            }
            String p31 = rest.substring(0, 3), p32 = rest.substring(3, 6);
            if (p31.endsWith("0") && p32.endsWith("0")) {
                chunks.add(p31); chunks.add(p32); chunks.add(rest.substring(6)); return chunks;
            }
            chunks.add(rest.substring(0, 2));
            chunks.add(rest.substring(2, 4));
            chunks.add(rest.substring(4, 6));
            chunks.add(rest.substring(6));
            return chunks;
        }
        if (!phone.startsWith("0")) {
            if (length == 8) {
                chunks.add(phone.substring(0, 2)); chunks.add(phone.substring(2, 4));
                chunks.add(phone.substring(4, 6)); chunks.add(phone.substring(6)); return chunks;
            }
            if (length == 4 || length == 5) { chunks.add(phone); return chunks; }
        }
        if (length == 10 && phone.startsWith("9")) {
            chunks.add(phone.substring(0, 3)); chunks.add(phone.substring(3, 6));
            chunks.add(phone.substring(6, 8)); chunks.add(phone.substring(8)); return chunks;
        }
        chunks.add(phone);
        return chunks;
    }

    private static String readPhoneChunk(String chunk) {
        if (chunk.isEmpty()) return "";
        boolean allZero = true;
        for (int i = 0; i < chunk.length(); i++) if (chunk.charAt(i) != '0') { allZero = false; break; }
        if (allZero) {
            int n = chunk.length();
            if (n == 2) return "دو صِفر";
            if (n == 3) return "سِِتا صفر";
            if (n == 4) return "چهارتا صفر";
            return numToText(n) + " تا صِفر";
        }
        List<String> parts = new ArrayList<>();
        int i = 0;
        while (i < chunk.length() && chunk.charAt(i) == '0') {
            parts.add("صِفر");
            i++;
        }
        if (i < chunk.length()) parts.add(numToText(Long.parseLong(chunk.substring(i))));
        return joinSpace(parts);
    }

    private static String joinVa(List<String> parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) {
            if (p == null || p.isEmpty()) continue;
            if (b.length() > 0) b.append(" و ");
            b.append(p);
        }
        return b.toString();
    }

    private static String joinComma(List<String> parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) {
            if (b.length() > 0) b.append("، ");
            b.append(p);
        }
        return b.toString();
    }

    private static String joinSpace(List<String> parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) {
            if (b.length() > 0) b.append(' ');
            b.append(p);
        }
        return b.toString();
    }

    private PersianFrontend() {}
}
