# dsh-delete-message

[简体中文](./README.md) | English

A per-message delete plugin for DeepSeek Harness that keeps accidental or mistaken messages out of the model context. It adds a delete button to the action area of every chat message: once confirmed, the message is removed from the **model context** through the host's official surface-replace contract (an assistant reply takes its thinking, tool calls, and injected context with it) and hidden from the **visible transcript**. Raw log bytes are never rewritten and can be recovered at any time.

## Features

- **All message types** — assistant replies mount in the official `conversation.chat.assistant-actions` slot; user input is enhanced via DOM augmentation (the host has no user-side action-strip extension point yet).
- **Native visual consistency** — reuses the host's icon and button geometry, the primitives `Tooltip`, and the `Modal`+`Button` confirm dialog; adapts to light and dark themes automatically.
- **Context-level deletion** — after confirmation, a `surfaceOp: { op: 'replace' }` placeholder node is appended (the same mechanism as the host's `/compact`); shadowed messages no longer enter `deriveMessages()`.
- **Transcript-level hiding** — the host's visible transcript is append-only by design, so the plugin maintains a per-session deleted-seq ledger (persisted in localStorage), resolves row wrappers' React fiber identities to hide matching rows, and heals historically deleted rows unknown to this browser via a `/status` preflight at load time.
- **Role-aware confirmation** — the confirm dialog body is selected automatically from each mount's static message role; no user judgment required: a user message states its single-message scope, while an assistant reply states that its thinking, tool calls, and injected context are removed together with it.
- **Bilingual UI (zh/en)** — all UI copy (confirm dialogs, failure reasons, accessibility labels) ships with Chinese and English dictionaries, switched by browser language and host preference.

## Screenshots

![Delete button in the message action area](docs/screenshots/delete-action.png)

![Delete confirmation dialog](docs/screenshots/confirm-dialog.png)

![Deleted message disappears from the session](docs/screenshots/deleted-hidden.png)

> Screenshot files live in [docs/screenshots/](docs/screenshots/); see that directory's README for what each image should show.

## Safety

- The server re-runs full validation before every deletion: only `user/message` and `assistant/message` surface nodes inside closed turns are accepted; messages carrying tool calls, already-shadowed messages, and in-progress turns are refused with machine reason codes (localized in the UI).
- The HTTP write path requires a dual-condition fence: loopback peer address AND a local Host header.
- Zero configuration, zero runtime dependencies; the plugin never deletes files or rewrites logs.

## Installation (web profile)

```sh
dsh plugin --profile web add github:viplocco/dsh-delete-message#v0.1.4
```

After installing, **fully restart the DSH Web process** (the host-side plugin tree is read only at startup); the client bundle is served dynamically per request by the host, so updates take effect on a hard refresh.

## Development

```sh
pnpm test    # node --test
```

See [docs/DESIGN.md](docs/DESIGN.md) for architecture, host contracts, and design trade-offs. Contact: viplocco@qq.com

## License

MIT
