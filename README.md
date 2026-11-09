# First Haven Escrow: demo homepage

Single-file HTML/CSS demo of a homepage for First Haven Escrow (Buena Park, CA). Open `index.html` in a browser.

Service names and FAQ answers are placeholders. Logo is the supplied First Haven Escrow logo (`logo.png`).

## Jessica Preview

Protected Vercel Preview enables Jessica with `FIRST_HAVEN_ANAM_PREVIEW=true`.
For an approved invite-only demo, use `FIRST_HAVEN_ANAM_TESTER_DEMO=true` at
build and runtime. The “Open an escrow” links fall back to the contact section
when neither demo is enabled.

Set `ANAM_API_KEY`, `ELEVENLABS_API_KEY`, `ANAM_QUOTA_REDIS_REST_URL`, and
`ANAM_QUOTA_REDIS_REST_TOKEN` as Preview secrets. Configure `ANAM_AVATAR_ID`,
`ELEVENLABS_AGENT_ID`, and `ELEVENLABS_AGENT_VERSION_ID` server-side. Use a
FirstHaven3-only version of the existing ElevenLabs agent with zero default
traffic. `scripts/prepare-intake-version.mjs` creates and verifies that version
only in an explicit FirstHaven3 Preview setup build. Set
`ANAM_TEST_REPORT_RETENTION=approved` at build and runtime only for the approved
fictional-data demo. This disables Anam zero data retention for the
demo. Audio/video recordings and stored transcripts stay off, but Anam may
retain other session reports. The default requires zero data retention.

The invite-only demo requires `ANAM_TESTER_ACCESS_CODE_SHA256` server-side, the
hexadecimal SHA-256 of a randomly generated 32-byte base64url token. Share
`/#jessica-invite=<token>` privately. The browser removes the fragment and holds
the invite in page memory, so a reload requires opening the invite again. The
server checks the token before microphone access and again before reserving quota. Production requires its own Redis credentials.
Prepare the invite-only agent version with `--tester` and the previously
verified Preview version as `FIRSTHAVEN3_TESTER_PARENT_VERSION_ID`. Pin the new
version to the tester deployment only.

The quota ledger reserves up to 20 starts per UTC day, permits one concurrent
session, and stores no intake fields. The avatar and provider each enforce the
three-minute session limit. Names such as John Smith are valid fictional
examples. Reserved email, phone and property-address rules still apply.
The intake draft is in memory and there is no submission endpoint.

Run `npm test` and `npm run typecheck`. Run `npm run test:browser` with
Python Playwright and Chromium for the simulated microphone, avatar, intake
tool, and call lifecycle checks.
