<p align="center">
  <img src="assets/icon_color.svg" alt="Linker mascot" width="128">
</p>

<h1 align="center">Linker</h1>

<p align="center">
  Create personal <code>go/</code> shortcuts for the websites you use most. 🦝
</p>

Know what go/links are? Great!

Don't know what go/links are? If curious, read about it [here!](https://www.trot.to/history-of-go-links)

Linker is an extension which allows you to have go/links functionality on your browser, completely offline and locally!

## Preview

<p align="center">
  <img src="assets/linker-preview.webp" alt="Linker preview" width="720">
</p>

## How it works

Linker's core workflow is simple: create a shortcut, then use `go/` to open it quickly.

### Create a shortcut

```mermaid
flowchart LR
  A["Linker toolbar icon is clicked"] --> B["Linker manager opens in the side panel"]
  B --> C["Add new shortcut is selected"]
  C --> D["Shortcut name and destination are entered"]
  D --> E["Save shortcut is clicked"]
  E --> F["Shortcut appears in the manager"]
```

### Open a shortcut

```mermaid
flowchart LR
  A["go/<shortcut> is entered"] --> B["Linker finds the matching shortcut"]
  B --> C{"Parameterized shortcut?"}
  C -->|No| D["Browser opens the saved destination"]
  C -->|Yes| E{"Value follows the shortcut?"}
  E -->|Yes| F["Value replaces {*} in the destination"]
  F --> G["Browser opens the resulting destination"]
  E -->|No| H["Browser opens the default destination"]
```

## Details

* Create, edit, search, and delete personal `go/` shortcuts.
* Open shortcuts from the manager or by visiting `go/<shortcut>`.
* Type `go/` then press Space to find saved shortcuts in Chrome's address bar.
* Use `{*}` for parameterized shortcuts, such as `go/issues/123`.
* Set a default destination when a parameterized shortcut is opened without a value.
* Linker uses the sideBar API, meaning you can have the Linker manager open whenever you need it, always there.
* Plan on moving the database anywhere, or moving from [Linkify](https://chromewebstore.google.com/detail/linkify/gojgbkejhelijlkgpmlbbkklljgmfljj)? You can import and export!
* Chrome Sync compatible.
* Has both Dark and Light themes, automatically syncing with your browser settings!

For examples and the full explanation, see the [How to use Linker guide](https://github.com/taichikuji/Linker/wiki/How-to-use-Linker).

Read the [Linker Privacy Policy](PRIVACY.md) for details about shortcut data and Chrome Sync.

## Scope

* This does not allow you to host said go/links online, or "share" them with friends. ( unless you want to share your configuration! )
* There's no proxy, or outbound connection when using your go/links.
* It is not a replacement for your bookmarks. It does not intend to be, either.
* Does not require you to have an account to use it.
* It does not replace the browser's history, or ordinary searches either.

Linker has a simple objective: Be the best at one thing. That one thing is having go/links functionality for your browser to speed up your way of working.

## Installation

Install Linker from the [Chrome Web Store](https://chromewebstore.google.com/detail/linker/nacggecaljkbjoghmiidmkpgpkfpmhgm).

## A small note about Firefox

Although Linker supports MV3 which is also supported on Firefox, there's no official support for this as I do not personally use it.

You may want to port the extension to Firefox. I won't stop you. If you want to help me do this, I'd also appreciate it!

## Development

To develop new features, or fix bugs, follow this;

The project has no runtime dependencies. Run the test suite with Bun:

```bash
bun test
```

Before releasing, test the extension in Chrome and at least one other Chromium browser such as Brave or Edge. Check the side panel at narrow and wide widths, URL prefill, direct and parameterized shortcuts, import/export, redirect rules, and behavior after restarting the browser. The release workflow is documented in [GUIDE.md](.github/workflows/GUIDE.md).

## Contributing

I am more than happy to see and welcome contributors! Just please respect my way of coding.

I like things minimal and code should be readable and efficient.
If you see something you'd genuinely do better than me, I'd be more than happy to accept a Pull Request from you!

## Support

If you would like to support me, you can [buy me a coffee via PayPal](https://paypal.me/ivanperezf).

## Icon palette

- White: [#fce7d2](https://www.color-hex.com/color/fce7d2)
- Orange: [#db8758](https://www.color-hex.com/color/db8758)
- Brown: [#b13d14](https://www.color-hex.com/color/b13d14)

Found a bug or have an idea? Please report it with enough context to reproduce the behavior.

Thanks for taking the time to use Linker.

Much love 🦝❤️
