# Bandwidth Labs SDKs

Official client SDKs for Bandwidth Labs services.

| SDK | Package | Directory |
|---|---|---|
| Python | `bw-stt` | [`python/`](python/) |
| TypeScript / Node | `@bandwidth-labs/bw-stt` | [`typescript/`](typescript/) |

Both SDKs cover the Speech to Text API: streaming transcription over the
`/audio/v1/listen` WebSocket in instant and demand modes, whole-file
transcription over `POST /audio/v1/transcribe`, PII redaction, and keyword
boosting. Each package ships typed events, word-level timestamps, and
transcript assembly utilities, with a runnable example under its `examples/`
directory.

Create an API key from your dashboard at
[labs.bandwidth.com](https://labs.bandwidth.com), set it as
`BW_STT_API_KEY`, and follow the quickstart in the SDK's README.

## Publishing a package

The **Publish package** GitHub Actions workflow can be run manually for either
`typescript` or `python`. It reads the version already configured in the
selected package, builds it without modifying the source, and publishes it to
npm or PyPI. Run it from the repository's default branch after the version
change has been merged. If that version has already been published, the
registry rejects it and the publish job fails.

Before merging a release, update the package version in the corresponding
files:

- **TypeScript:** Update `version` in `typescript/package.json` and keep
  `typescript/package-lock.json` synchronized.
- **Python:** Update `version` in `python/pyproject.toml` and `__version__` in
  `python/src/bw_stt/__init__.py` to the same new package version.

Configure trusted publishing for each registry before running the workflow:

- On npm, add a GitHub Actions trusted publisher for
  `@bandwidth-labs/bw-stt` using organization `Bandwidth`, repository
  `bw_labs_sdks`, workflow `publish.yml`, and no environment. The workflow
  authenticates through GitHub OIDC and does not require an npm token.
- On PyPI, add a GitHub Actions trusted publisher for `bw-stt` using owner
  `Bandwidth`, repository `bw_labs_sdks`, workflow `publish.yml`, and
  environment `pypi`. A pending publisher can be configured before the first
  release.
