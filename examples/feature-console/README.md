# STT feature console

This is a local manual test console for the Speech to Text API using the
TypeScript SDK in `../../typescript`. It provides instant streaming, demand
streaming, PII options, raw event inspection, microphone capture, and whole-file
transcription in one browser page.

## Run

```sh
npm install
npm start
```

Open <http://127.0.0.1:8099> and paste an API key into the console. The base URL
defaults to `https://api.labs.bandwidth.com`. For a port-forwarded instance,
point it at `http://127.0.0.1:PORT`.

The API key stays in the local process memory. It is not written to browser
storage or console logs.

## Checks

```sh
npm run typecheck
```

The server binds to `127.0.0.1` only.
