# Bluke Persian Keyboard v1.2.0 signed test APK

This directory contains a signed test APK encoded in bounded base64 chunks so the binary can be reconstructed without a large artifact store.

Reassembly:
```sh
cat apk.b64.part-* | base64 -d > Bluke-Persian-Keyboard-v1.2.0.apk
sha256sum -c SHA256SUMS.txt
```

The APK was verified by apksigner using APK Signature Scheme v3. It is signed with a self-generated test certificate, not the upstream publisher's certificate. It has application ID dev.arnv.bluke.persian, minSdk 28 (Android 9), targetSdk 36.
