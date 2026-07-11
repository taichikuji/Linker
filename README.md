# Linker

A small browser extension for creating personal URL shortcuts.

Type `go/<shortcut>` in the address bar and Linker takes you to the website you
saved. Everything is stored in browser sync storage so your shortcuts can follow
your signed-in browser profile.

## Installation

1. Open your browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select this directory.

To keep Linker visible in the browser toolbar, open the browser's extensions
menu and pin Linker. Toolbar placement is controlled by the browser.

Linker uses Manifest V3 and requires support for dynamic declarative network
request rules.

## User guide

### Create or overwrite a shortcut

1. Open the website you want to save.
2. Open Linker and expand **Add new shortcut**.
3. Confirm the destination URL. The active tab is used by default.
4. Enter a shortcut name.
5. Select **Save shortcut**.

If that shortcut already exists, Linker changes the action to **Overwrite**.

### Create a parameterized shortcut

Add `{*}` to a destination URL to insert a value from the go link. Linker shows
a **Variable** badge and asks for a **Default go link to** URL when it detects
the token. In the popup list, parameterized shortcuts have a **VAR** badge and
show the fallback URL's host and path instead of the variable destination.

For example, configure:

- Destination URL: `https://tracker.example.com/browse/{*}`
- Default go link to: `https://tracker.example.com/`
- Shortcut: `issue`

Then:

- `go/issue/ISSUE-123` opens
  `https://tracker.example.com/browse/ISSUE-123`.
- `go/issue` opens the configured issue tracker.

The same syntax works in query strings. A destination such as
`https://www.ecosia.org/search?method=index&q={*}` turns
`go/ecosia/94321223` into a search for `94321223`.

### Open a shortcut

- Type `go/<shortcut>` in the current or a new tab.
- For parameterized shortcuts, type `go/<shortcut>/<value>`.
- Or open Linker and select the shortcut from the list.

If the browser sends `go/<shortcut>` to its search engine first, Linker also
recognizes encoded static and parameterized go links and redirects them.

### Find and delete shortcuts

- Search matches both shortcut names and destination URLs.
- Move over a shortcut (or focus it with the keyboard) and select the delete
  action. Linker asks for confirmation before removing it.

### Import and export

Use the arrow actions in the header to import or export JSON. Simple shortcuts
remain URL strings. Parameterized shortcuts use an object:

```json
{
  "docs": "https://example.com/docs",
  "issue": {
    "url": "https://tracker.example.com/browse/{*}",
    "fallbackUrl": "https://tracker.example.com/"
  }
}
```

Exports created by the previous Linkify version remain compatible and can be
imported without migration. Existing `chrome.storage.sync` entries also continue
to use the original data shape.

## Verification

After loading or reloading the unpacked extension, verify:

- A static `go/<shortcut>` still opens its saved URL.
- `go/issue/ISSUE-123` substitutes the issue ID into the destination.
- Bare `go/issue` opens the configured fallback URL.
- Parameterized links also work when the browser sends them through its search
  engine.
- Exporting and reimporting the JSON preserves fallback URLs.
