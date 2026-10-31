import unittest
from decimal import Decimal
from voice_plan_guard import VoiceGuardError, plan_parts, verify_provider_receipts


class Planner(unittest.TestCase):
    def assert_cover(self, duration, expected_count, expected_lens=None, cap=59):
        parts = plan_parts(duration, cap_seconds=cap)
        self.assertEqual(len(parts), expected_count)
        self.assertEqual(parts[0].start, Decimal(0))
        self.assertEqual(parts[-1].end, Decimal(str(duration)))
        self.assertTrue(all(p.seconds <= Decimal(str(cap)) and p.seconds >= Decimal('1.2') for p in parts))
        self.assertTrue(all(a.end == b.start for a, b in zip(parts, parts[1:])))
        if expected_lens is not None:
            self.assertEqual([p.seconds for p in parts], list(map(Decimal, map(str, expected_lens))))
        return parts

    def test_59(self): self.assert_cover(59, 1, [59])
    def test_59_1(self): self.assert_cover(59.1, 2, [57.9, 1.2])
    def test_60(self): self.assert_cover(60, 2, [58.8, 1.2])
    def test_long(self): self.assert_cover(1200, 21, [59]*20 + [20])
    def test_four(self): self.assert_cover('202.840816', 4, ['59','59','59','25.840816'])
    def test_micro_tail(self): self.assert_cover('118.000001', 3, ['59', '57.800001','1.2'])
    def test_conservative_cap(self): self.assert_cover(120, 3, cap=56)
    def test_runtime_full_drain_cap(self):
        self.assert_cover(112, 3, ['54','54','4'], cap=54)
        self.assert_cover(1200, 23, [54]*22 + [12], cap=54)
    def test_original_59s_ceiling_still_admitted(self):
        self.assert_cover(1200, 21, [59]*20 + [20], cap=59)
    def test_1000_parts(self): self.assert_cover(60000, 1017)
    def test_high_precision(self): self.assert_cover('59.0000000009', 2)
    def test_invalid(self):
        for d in [float('nan'), float('inf'), 0, -1, 'blah', True, 1.1]:
            with self.subTest(d=d), self.assertRaises(VoiceGuardError): plan_parts(d)
        for cap in [59.1, 0, 1, 1.1, float('nan')]:
            with self.subTest(cap=cap), self.assertRaises(VoiceGuardError): plan_parts(120, cap_seconds=cap)


class Receipts(unittest.TestCase):
    def parts(self): return plan_parts(118)
    def ok(self, parts):
        return [{'chunk':i+1,'status':'VOICE_SENT_VERIFIED','direction':'out',
                 'capture_seen':True,'pacat_rc':0,'pacat_finished_before_release':True,
                 'bubble_s':59,'held_s':59.5} for i,_ in enumerate(parts)]

    def test_exact_verified(self):
        p=self.parts(); r=verify_provider_receipts(p,self.ok(p))
        self.assertEqual(r['parts'], len(p))
        self.assertFalse(r['full_source_audio_fidelity_verified'])

    def test_reject_unverified(self):
        for status in ['VOICE_SENT_UNVERIFIED', 'IN_DOUBT_NO_NEW_ROW', 'SKIPPED_ALREADY_ATTEMPTED', 'RELEASED']:
            p=self.parts(); r=self.ok(p);r[0]['status']=status
            with self.subTest(status=status), self.assertRaises(VoiceGuardError):verify_provider_receipts(p,r)

    def test_no_premature_release(self):
        p=self.parts();r=self.ok(p);r[1]['pacat_finished_before_release']=False
        with self.assertRaisesRegex(VoiceGuardError,'FULL_AUDIO_PLAYBACK'):verify_provider_receipts(p,r)

    def test_order_and_coverage(self):
        p=self.parts();r=self.ok(p);r[0]['chunk']=2
        with self.assertRaisesRegex(VoiceGuardError,'OUT_OF_ORDER'):verify_provider_receipts(p,r)
        with self.assertRaisesRegex(VoiceGuardError,'MISSING_CHUNK'):verify_provider_receipts(p,r[:1])

    def test_limit(self):
        p=self.parts();r=self.ok(p);r[0]['bubble_s']=61
        with self.assertRaisesRegex(VoiceGuardError,'BUBBLE_OVER'):verify_provider_receipts(p,r)
        r=self.ok(p);r[0]['held_s']=60.01
        with self.assertRaisesRegex(VoiceGuardError,'HOLD_OVER'):verify_provider_receipts(p,r)

if __name__ == '__main__': unittest.main()
