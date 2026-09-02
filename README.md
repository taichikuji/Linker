# Linker

A small browser extension for creating personal URL shortcuts.

## Installation

Linker supports Chromium 116 or newer on desktop, including Google Chrome,
Brave, Microsoft Edge, Opera, Vivaldi, and compatible Chromium forks.

For the canonical installation and usage guide, see [How to use Linker](https://github.com/taichikuji/Linker/wiki/How-to-use-Linker).

## Description

Linker currently provides:

- Add, search, delete, and edit _go/link_ based URLs.
- Open shortcuts by clicking them or typing `go/<value>` in the browser.
- Use `{*}` for dynamic, parameterized links.
- Export and import shortcut data, compatible with [Linkify](https://chromewebstore.google.com/detail/linkify/gojgbkejhelijlkgpmlbbkklljgmfljj).

For the examples and the full explanation, see the [How to use Linker](https://github.com/taichikuji/Linker/wiki/How-to-use-Linker) guide.

## Why is there no Firefox build?

Linker was created for Chromium-based browsers and has never been fully tested
on Firefox. It has also not been actively used there, nor has Firefox support
been requested. Maintaining a build that cannot be confidently validated is
therefore outside Linker's scope.

## Tag versioning workflow

For the workflow on how to generate and push new releases with tags, read [GUIDE.md](.github/workflows/GUIDE.md)

## Testing

Run the zero-dependency test suite with Node.js 20 or newer:

```bash
node --test
```

The tests execute the real background and manager scripts against Chromium's
standard `chrome.*` extension API namespace; despite its name, that namespace
is shared by compatible Chromium-based browsers. Before releasing, load Linker
in current Chrome and Brave, verify the side panel and its URL prefill at narrow
and wide widths, then create direct and parameterized shortcuts, verify both
redirect, restart each browser, and verify the redirects again.

Linker supports both light and dark system themes. Shortcut data is stored in
Chrome sync storage; Linker does not send it to a developer-operated service.

## Is there a Google Extension Store URL available?

Not at this time. Thinking about having to pay 5$ just to upload it hurts my soul a little bit. If someone donates that amount I will ensure to upload it in due time. Teehee.

If you want to help me with this, I'd really appreciate it, just go ahead and drop a coffee here: [paypal.me](https://paypal.me/ivanperezf)

## What is the color palette of the project's icon?

* White: [#fce7d2](https://www.color-hex.com/color/fce7d2)
* Orange: [#db8758](https://www.color-hex.com/color/db8758)
* Brown: [#b13d14](https://www.color-hex.com/color/b13d14)

---

Anyways that's it for real now. Thanks as always. If you find bugs or errors report them accordingly.
