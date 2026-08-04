# Import official T3 Code data

The T3 Turbo desktop app can copy projects and chats from a separate official T3 Code database
directly into Turbo. It does not start or connect to a second T3 Code server.

Open the environment menu in the desktop app and choose **Import official T3 Code…**. Turbo checks
both databases, temporarily stops its local backend, creates a recovery backup, applies the import,
and restarts the backend.

Finish active turns and approvals and quit official T3 Code before importing. If an official chat
has the same ID as a different Turbo chat, choose one action for that chat:

- **Keep both** gives the official chat a new ID and preserves both histories.
- **Replace Turbo** overwrites the Turbo chat with the official history.
- **Skip** leaves the Turbo chat unchanged.

The dialog also shows repeatable `t3 import official` commands. Use `plan` to inspect an import
without changing the Turbo database, `run` to plan and apply an import, and `restore` with the
receipt path if you need to recover the pre-import database backup.

Import is local-desktop only. Relay and remote clients see the imported data after the Turbo
backend reconnects; they do not copy database files themselves.
