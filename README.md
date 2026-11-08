# First Haven Escrow: demo homepage

Single-file HTML/CSS demo of a homepage for First Haven Escrow (Buena Park, CA). Open `index.html` in a browser.

Service names and FAQ answers are placeholders. Logo is the supplied First Haven Escrow logo (`logo.png`).

## Jessica Preview

Jessica is enabled only for Vercel Preview with `FIRST_HAVEN_ANAM_PREVIEW=true`.
The “Open an escrow” links fall back to the original contact section in other builds.

Set `ANAM_API_KEY`, `ELEVENLABS_API_KEY`, `ANAM_QUOTA_REDIS_REST_URL`, and
`ANAM_QUOTA_REDIS_REST_TOKEN` as Preview secrets. Configure `ANAM_AVATAR_ID`,
`ELEVENLABS_AGENT_ID`, and `ELEVENLABS_AGENT_VERSION_ID` server-side. Use a
FirstHaven3-only version of the existing ElevenLabs agent with zero default
traffic. `scripts/prepare-intake-version.mjs` creates and verifies that version
only in an explicit FirstHaven3 Preview setup build. Set
`ANAM_TEST_REPORT_RETENTION=approved` at build and runtime only for the approved
protected fictional-data demo. This disables Anam zero data retention for the
demo. Audio/video recordings and stored transcripts stay off, but Anam may
retain other session reports. The default requires zero data retention.

The quota ledger reserves up to 20 starts per UTC day, permits one concurrent
session, and stores no intake fields. The avatar and provider each enforce the
three-minute session limit. Names such as John Smith are valid fictional
examples. Reserved email, phone and property-address rules still apply.
The intake draft is in memory and there is no submission endpoint.

Run `npm test` and `npm run typecheck`. Run `npm run test:browser` with
Python Playwright and Chromium for the simulated microphone, avatar, intake
tool, and call lifecycle checks.
