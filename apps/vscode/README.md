# HeyLoop for VS Code

Connects this VS Code window to your local HeyLoop daemon (`127.0.0.1`) so you can start new Copilot Agent chats from your phone.

## Features

- Registers this VS Code window with the local HeyLoop daemon over an authenticated localhost SSE stream.
- Opens a fresh Copilot Agent chat and submits the prompt when a `new_chat` event arrives from your phone.
- Shows connection state in the status bar and provides **HeyLoop: Reconnect** (`heyloop.reconnect`).

## Configuration

Reads `port` and `token` from `$HEYLOOP_HOME/config.json` (default `~/.heyloop/config.json`).
