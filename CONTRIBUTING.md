# Contributing

Thanks for helping! Bug reports, light-compatibility reports and pull requests are all welcome.

## Reporting a problem
Use **Help → Report a problem** in the app: it opens a GitHub issue with the app version and your browser filled in.
Or open an issue directly and pick a template. The most useful things to include:
- what you did, what you expected, what happened;
- the **log**: Settings → Advanced → *Show the Debug tab*, reproduce the problem, then copy the last 30–50 lines
  from the Debug tab. The log contains the commands sent to the light and its replies. It also contains a
  browser-generated device id (not the light's Bluetooth address); remove it if you prefer.

**Do not attach raw Bluetooth captures** (`.pklg`, `.btsnoop`): they record every nearby device, not just your light.

## Other GVM lights
If you have a different GVM model, open a **Light report** issue: whether it shows up as `BT_LED`, whether it
connects, and which controls work. A filtered capture of the official app (only the light's frames) helps add support.

## Development
The app is plain HTML/CSS/JavaScript modules in `web/`; there is no build step.
```
bash web/serve.sh                     # http://localhost:8765 (Web Bluetooth needs https or localhost)
node --test tests/protocol.test.mjs   # protocol, crossfade, effect, gel and custom-effect tests (Node 18+)
git config core.hooksPath .githooks   # once per clone: version bump on every commit
```
See [docs/TECHNICAL.md](docs/TECHNICAL.md) for how the app and the protocol work.

### Ground rules for the light protocol
- **No guessed bytes.** Every command byte must come from a packet capture of the official app, or be confirmed on
  a real light. Say in the pull request which it is.
- **No fuzzing**, no brute-forcing unknown commands, and never write to anything that looks like firmware update
  (OTA/DFU). The app blocks such characteristics; keep it that way.
- Never send commands faster than the official app does (one write per 60 ms per light; effect steps ≥ 200 ms).
- Be clear about what was tested on hardware and what only in a simulator.

## Versions and the changelog
- `web/setup.js` holds `APP_VERSION`; the offline cache name in `web/sw.js` follows it.
- The pre-commit hook bumps the **minor** version on every commit (1.3.0 → 1.4.0). If a commit already changes
  the version, the hook leaves it. Skip it once with `SKIP_BUMP=1 git commit …`. For a major or patch release run
  `scripts/bump-version.sh major` (or `patch`) and commit.
- Write what changed under **## [Unreleased]** in `CHANGELOG.md`. When the hook bumps the version it renames that
  section to the new version and today's date and starts a new empty Unreleased section.

## Pull requests
Keep them focused, describe how you tested (real light or simulator), and update `CHANGELOG.md` under Unreleased.
