# moz-agent

Firefox extension stub. Goal: an agentic tool that connects to a user's browser
session and lets an external agent observe/act on it.

## Status

Bare stub. Background script and popup log to console only, no real connection yet.

## Structure

- `extension/manifest.json` - MV3 manifest, Firefox gecko id set
- `extension/background.js` - background script, will hold the connection to the agent server
- `extension/popup/` - toolbar popup UI
- `extension/icons/` - not populated yet

## Dev

```
npm install
npm run lint
npm run run
```

`npm run run` uses `web-ext run` to load the extension into a temporary Firefox profile.

## Next steps

- pick a transport for the agent connection (websocket vs native messaging)
- add the agent server (node), with HURL tests against its HTTP/WS endpoints
- content script for page-level actions
- auth/session handoff between extension and agent server
