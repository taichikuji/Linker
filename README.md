# Linker

A small browser extension for creating personal URL shortcuts.

Type `go/<shortcut>` in the address bar and Linker takes you to the website you
saved. Everything is stored in browser sync storage so your shortcuts can follow
your signed-in browser profile.

## Installation

1. Open your browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select this directory.

Linker uses Manifest V3 and requires support for dynamic declarative network
request rules.

## User guide

### Create or overwrite a shortcut

1. Open the website you want to save.
2. Open Linker and expand **Add new shortcut**.
3. Enter a shortcut name. The active tab is used as the destination by default.
4. Select **Save shortcut**.

If that shortcut already exists, Linker changes the action to **Overwrite**.

### Open a shortcut

- Type `go/<shortcut>` in the current or a new tab.
- Or open Linker and select the shortcut from the list.

If the browser sends `go/<shortcut>` to its search engine first, Linker also
recognizes the encoded search URL and redirects it.

### Find and delete shortcuts

- Search matches both shortcut names and destination URLs.
- Move over a shortcut (or focus it with the keyboard) and select the delete
  action. Linker asks for confirmation before removing it.

### Import and export

Use the arrow actions in the header to import or export JSON. Linker exports a
simple object mapping shortcut names to URL strings.

Exports created by the previous Linkify version remain compatible and can be
imported without migration. Existing `chrome.storage.sync` entries also continue
to use the original data shape.

## Verification

See [TESTING.md](TESTING.md) for the behavior-parity checklist used by the
Linkify-to-Linker migration.
