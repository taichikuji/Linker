# Linker

A small browser extension for creating personal URL shortcuts.

## Installation

1. Open your browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select this directory.

To keep Linker visible in the browser toolbar, open the browser's extensions
menu and pin Linker. Toolbar placement is controlled by the browser.

Linker uses Manifest V3 and requires support for dynamic declarative network
request rules.

## Tag versioning workflow

For the workflow on how to generate and push new releases with tags, read [GUIDE.md](.github/workflows/GUIDE.md)

## Description

At this time ( it will update ) it does the following:

### Functionality

#### Add, Search, Delete, Edit _go/link_ shortcuts

You can add, delete, overwrite _go/link_ based URLs! As expected.

There's a search bar at the top, which you can use to search existing entries.

#### Using _go/links_

You can both click on the extension's saved entries to go to the bookmark / shortcut, or type on your browser `go/<value>` to go whichever entry contains `<value>`

For example;

> go/gh --> redirects to --> github.com

#### Dynamic syntax ( cool stuff! )

You can use variables or parameterized values on your go/links! Let me explain;

For example:

> go/gh/taichikuji/linker --> redirects to --> github.com/**taichikuji/linker**

You can use `{*}` within a destination URL to redirect dynamically to said URL. This can help speed up a lot your browsing experience!

Another example:

> go/issue/linker --> redirects to --> github.com/taichikuji/issues/**linker**

There's a lot that you can do purely based on this! And none is hardcoded, so you can customize this behaviour to your liking!

### Import and export

You can export your database for sharing with another computer, or if you are going to reset your PC... Whatever you want to do. This allows you to essentially make a backup of your current state of the Linker Database.

It follows the same JSON nomenclature for exporting/importing as [Linkify](https://chromewebstore.google.com/detail/linkify/gojgbkejhelijlkgpmlbbkklljgmfljj), hence it is directly compatible ( for now! ) and you can migrate easily to Linker if you want.

---

That's it for now. As you can see it is minimal, but I will continue to work on it as it goes on. This is by design, just like [Stasher](https://github.com/taichikuji/Stasher/).

## Is there a Google Extension Store URL available?

Not at this time. Thinking about having to pay 5$ just to upload it hurts my soul a little bit. If someone donates that amount I will ensure to upload it in due time. Teehee.

If you want to help me with this, I'd really appreciate it, just go ahead and drop a coffee here: [paypal.me](https://paypal.me/ivanperezf)

## What is the color palette of the project's icon?

* White: [#fce7d2](https://www.color-hex.com/color/fce7d2)
* Orange: [#db8758](https://www.color-hex.com/color/db8758)
* Brown: [#b13d14](https://www.color-hex.com/color/b13d14)

---

Anyways that's it for real now. Thanks as always. If you find bugs or errors report them accordingly.
