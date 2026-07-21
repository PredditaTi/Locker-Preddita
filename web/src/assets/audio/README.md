# Audio assets

The twelve `.m4a` files in this directory are fixed Portuguese kiosk prompts.
Their text is original PREDDITA project copy; no recording or copy was taken
from the reference application.

They were generated locally on 2026-07-20 with Apple macOS `say`, voice
`Luciana (pt_BR)`, at 175 words per minute, then converted with `afconvert` to
mono AAC-LC at 22,050 Hz and a target bitrate of 64 kbps. The build has no
runtime text-to-speech or network dependency.

`manifest.json` records the source text, origin, encoding, size, duration and
SHA-256 of every file. `scripts/audio-guidance-test.mjs` checks those values and
the privacy allowlist.

These are laboratory assets. The project must confirm that distribution of
output from the selected macOS system voice is permitted before a production
release. Replace the files with commissioned or otherwise cleared recordings
if that approval is not obtained; keep the same closed prompt IDs and update
the manifest hashes.
