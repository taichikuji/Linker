# Linker behavior checklist

This checklist records the Linkify behavior that the Linker revamp must preserve.
Run it after loading the unpacked extension from this directory.

## Shortcut storage

- Create a shortcut and verify it is stored in `chrome.storage.sync` as
  `{ "<shortcut>": { "url": "<target>", "rules": "Nothing for now" } }`.
- Reuse an existing shortcut and verify the Save button changes to Overwrite.
- Overwrite it and verify the existing entry changes rather than being duplicated.
- Delete one shortcut, cancel once, then confirm and verify only that entry is removed.

## Navigation

- Enter `go/<shortcut>` in the address bar and verify the current tab redirects.
- Search for `go/<shortcut>` and verify the encoded search URL redirects.
- Click a shortcut in the popup and verify its target opens in a new tab.
- Change a stored shortcut and verify its redirect rule updates without reloading Linker.

## Popup

- Search by shortcut and target URL, including a query with different letter casing.
- Verify an empty result shows the empty-search state.
- Open and close the Add new shortcut section using pointer and keyboard controls.
- Verify validation and storage errors appear inside the popup without closing it.

## Import and export compatibility

- Export shortcuts and verify the file is a JSON object mapping shortcuts to URL strings.
- Import that Linker export and verify valid entries are restored.
- Import an existing `linkify.json` file and verify its entries are accepted.
- Import malformed JSON and invalid entries and verify Linker reports the problem without
  replacing valid stored entries.
