# Bluke VPS local-state preservation (2026-11-17)

The server's two local Bluke work directories were inspected before cleanup.

- Public execution-plane working copy: clean branch `release/bluke-20261104-v126`, published commit `717c34eb67396167440d325db4bd5a564367e377`.
- Public export working copy: local base `5ea9cdbfd73512ee4e1c6203372bb8856cf5f5c7` of `build/bluke-keyboard-v1-20261102`, 39 commits behind the remotely published `f726d157bdce048b625408b344759fda4ac37ae7` at inspection. Its one unpublished README variant is preserved in `README_FA-local-unpublished.md`. The newer canonical README on the branch has **not** been replaced.
- Modified upstream checkout: source repository `https://github.com/arnav-kr/Bluke.git`, base commit `bcf4f1492b51bcbb97fc7b792f73ad6bed75c759`. Nine modified tracked files and two newly created Kotlin files are captured completely in `upstream-bluke-local-11-files.patch`. Apply the patch to a clean checkout of that exact upstream commit with `git apply upstream-bluke-local-11-files.patch`.
- Patch SHA-256: `0b8a8622e0c4de31bb5172b455b14a53abd3f1988c30f3f7d68733686d70e34b`.
- Local README SHA-256: `239dd53cbc8e1fad3e0710bc8d55492253472d4b45881a2a72fe5392ad53b80e`.

This archive preserves unpublished local changes without changing the released Bluke application or overwriting newer mainline documentation.
