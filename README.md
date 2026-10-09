# Pocket Pages

Read a whole book six minutes at a time. Pocket Pages cuts an EPUB into short reading sessions ("pockets") that end at natural breaks, made for the Xteink X4 and X4 Pro running [CrossPoint](https://crosspointreader.com). Each pocket opens with a small card and ends with one that, with Quick Resume, becomes the sleep screen and shows what comes next.

## What's here

| Path | What it is |
|---|---|
| `src/` | The website (Astro). The converter runs in the browser; books are never uploaded. |
| `src/lib/pocketpages.js` | The converter used by the site. |
| `python/pocketpages.py` | The same converter as a command-line script (the reference version). |
| `test/parity.mjs` | Runs both versions on a folder of test books and checks that every pocket matches. |
| `test/e2e.mjs` | Converts a book through the real page in headless Chromium and saves the download. |
| `firmware/` | Two small CrossPoint changes, and an experimental X4 Pro build. |
| `public/books/` | Ready-made editions of three Standard Ebooks classics. |

## Run the site

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static site in dist/
```

## Use the script

```sh
pip install lxml
python3 python/pocketpages.py book.epub book-pocket-pages.epub --minutes 6 --wpm 260
```

## How books are cut

1. Chapters come from the book's own table of contents. If there isn't a useful one, chapter headings in the text ("Chapter 7", "BOOK II", "XIV") are used, and failing that, one section per file. Project Gutenberg's own EPUBs use their `<h2>` chapter headings.
2. Front matter (title page, introduction) and back matter (notes, licence) are kept but not split into pockets.
3. Cuts fall at chapter ends, then scene breaks, then paragraph ends, never mid-paragraph. Each chapter's cuts are chosen together so pockets stay close to the target length. Very short chapters are merged.
4. A check confirms every word of the source lands in the output.

Reading speeds default to Brysbaert (2019): 260 words a minute for fiction, 238 for non-fiction.

## Deploy

The site is static. On Vercel, import the repository; the Astro preset is detected automatically. The domain is readpocketpages.com (set in `astro.config.mjs`); add it in the Vercel project's Domains settings.

## Licence

MIT. Book texts in `public/books/` come from [Standard Ebooks](https://standardebooks.org) and are in the public domain.
