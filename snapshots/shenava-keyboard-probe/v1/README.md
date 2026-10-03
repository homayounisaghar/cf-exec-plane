# Shenava Keyboard Probe v1

Secret-free standalone Android IME experiment. It is intentionally a separate package from Persian Voice Keyboard and does not modify or replace that app.

- Package: `com.najme.shenavatest`
- Version: `1 / 0.1.0`
- Engine: sherpa-onnx 1.13.8
- Model: Shenava Rizeh v1.0 streaming INT8 (Persian NeMo CTC export)
- Audio: 16 kHz mono PCM16, 100 ms capture chunks
- Publication: Android composing text (`setComposingText`) while speech is live; `finishComposingText` on manual stop
- Network: deliberately no `INTERNET` permission; model is bundled in the APK and copied to app-private files on first initialization
- ABI: arm64-v8a only for this device probe

The purpose is device comparison of local Persian ASR quality/latency and composing-text caret behavior. The existing Perplexity/Soniox keyboard path remains untouched.

Model attribution: Shenava Rizeh by Reza2kn; streaming INT8 sherpa-onnx conversion by mah92; CC-BY-NC-4.0. sherpa-onnx is Apache-2.0.
