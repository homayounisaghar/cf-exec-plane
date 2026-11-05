#!/usr/bin/env python3
"""One-line, exact-source repair for ChatGPT fileParams / structured ASR input drift."""
import sys
from pathlib import Path

START = '  server.registerTool("audio_transcribe", {'
END = '  server.registerTool("telegram_screenshot", {'
BAD = '    _meta: {"openai/fileParams":["files"]},\n'

def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_audio_schema.py <telegram-ingress.mjs>")
    path = Path(sys.argv[1])
    original = path.read_text(encoding="utf-8")
    assert original.count(START) == 1, "audio_transcribe declaration count changed"
    start = original.index(START)
    end = original.index(END, start)
    block = original[start:end]
    assert 'files: z.array(z.object({' in block, "audio files schema is no longer object-array"
    assert 'telegram_message_handle' in block and 'batch_id' in block
    assert block.count(BAD) == 1, "fileParams annotation absent or duplicated"
    updated_block = block.replace(BAD, "", 1)
    updated = original[:start] + updated_block + original[end:]
    assert updated == original.replace(BAD, "", 1), "unexpected source delta"
    path.write_text(updated, encoding="utf-8")
    print("CF_AUDIO_R274_EXACT_ONE_LINE_PATCH_OK")

if __name__ == "__main__":
    main()
