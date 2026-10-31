"""Fail-closed, pure planning and receipt verification for native WeChat voice.

This is a candidate library, NOT a provider integration and NOT a deployed CF tool.
It never opens an audio file or interacts with WeChat, PulseAudio, or a message.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Mapping, Sequence

MAX_PART = Decimal('59')
MIN_PART = Decimal('1.2')
MAX_MESSAGE_SECONDS = Decimal('60')


class VoiceGuardError(ValueError):
    """A condition that must stop sending without retrying any attempted part."""


def _time(value: object) -> Decimal:
    """Interpret ffprobe's decimal seconds without millisecond rounding loss."""
    if isinstance(value, bool):
        raise VoiceGuardError('INVALID_DURATION')
    try:
        t = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise VoiceGuardError('INVALID_DURATION') from None
    if not t.is_finite() or t <= 0:
        raise VoiceGuardError('INVALID_DURATION')
    return t


@dataclass(frozen=True)
class Part:
    index: int
    start: Decimal
    seconds: Decimal

    @property
    def end(self) -> Decimal:
        return self.start + self.seconds


def plan_parts(duration: object, *, cap_seconds: object = MAX_PART) -> tuple[Part, ...]:
    """Cover the source contiguously; never exceed 59s or permit tiny tail.

    cap_seconds can be reduced for audio-transport overhead but can never be
    raised above the owner's absolute 59-second bound. No fixed part-count cap.
    """
    end = _time(duration)
    cap = _time(cap_seconds)
    if cap > MAX_PART or cap < MIN_PART:
        raise VoiceGuardError('INVALID_CHUNK_CAP')
    if end < MIN_PART:
        raise VoiceGuardError('VOICE_TOO_SHORT')
    pieces: list[list[Decimal]] = []
    at = Decimal('0')
    while at < end:
        length = min(cap, end - at)
        pieces.append([at, length])
        at += length
    if len(pieces) > 1 and pieces[-1][1] < MIN_PART:
        need = MIN_PART - pieces[-1][1]
        if pieces[-2][1] - need < MIN_PART:
            raise VoiceGuardError('TAIL_REBALANCE_UNSAFE')
        pieces[-2][1] -= need
        pieces[-1][0] -= need
        pieces[-1][1] += need
    planned = tuple(Part(i + 1, a, n) for i, (a, n) in enumerate(pieces))
    at = Decimal('0')
    for part in planned:
        if part.start != at or not MIN_PART <= part.seconds <= cap:
            raise VoiceGuardError('CHUNK_COVERAGE_INVALID')
        at = part.end
    if at != end:
        raise VoiceGuardError('CHUNK_COVERAGE_INVALID')
    return planned


def verify_provider_receipts(parts: Sequence[Part], receipts: Sequence[Mapping]) -> dict:
    """Verify a completed send without treating UNVERIFIED as successful.

    This does not assess source-audio fidelity. A receiving-side audio readback
    is separately required before calling an arbitrary sender fully qualified.
    """
    if not parts or len(parts) != len(receipts):
        raise VoiceGuardError('MISSING_CHUNK_RECEIPT')
    for index, (part, receipt) in enumerate(zip(parts, receipts), 1):
        if receipt.get('chunk') != index:
            raise VoiceGuardError('OUT_OF_ORDER_RECEIPT')
        if receipt.get('status') != 'VOICE_SENT_VERIFIED':
            raise VoiceGuardError('IN_DOUBT_OR_UNVERIFIED_NO_RETRY')
        if receipt.get('direction') != 'out':
            raise VoiceGuardError('PROVIDER_OUTBOUND_NOT_VERIFIED')
        if receipt.get('capture_seen') is not True:
            raise VoiceGuardError('CAPTURE_NOT_VERIFIED')
        if receipt.get('pacat_rc') != 0 or receipt.get('pacat_finished_before_release') is not True:
            raise VoiceGuardError('FULL_AUDIO_PLAYBACK_NOT_VERIFIED')
        held = receipt.get('held_s')
        if held is None or isinstance(held, bool):
            raise VoiceGuardError('HOLD_DURATION_NOT_VERIFIED')
        try:
            hold = Decimal(str(held))
        except (InvalidOperation, ValueError):
            raise VoiceGuardError('HOLD_DURATION_NOT_VERIFIED') from None
        if not hold.is_finite() or not (Decimal('1') <= hold <= MAX_MESSAGE_SECONDS):
            raise VoiceGuardError('HOLD_OVER_PROVIDER_LIMIT')
        bubble = receipt.get('bubble_s')
        if bubble is None or isinstance(bubble, bool):
            raise VoiceGuardError('DURATION_NOT_VERIFIED')
        try:
            b = Decimal(str(bubble))
        except (InvalidOperation, ValueError):
            raise VoiceGuardError('DURATION_NOT_VERIFIED') from None
        if not b.is_finite() or not (Decimal('1') <= b <= MAX_MESSAGE_SECONDS):
            raise VoiceGuardError('BUBBLE_OVER_PROVIDER_LIMIT')
    return {'state': 'CHUNKS_PROVIDER_VERIFIED', 'parts': len(parts),
            'full_source_audio_fidelity_verified': False}
