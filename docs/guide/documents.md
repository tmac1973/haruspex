---
title: Documents
description: Making a PDF, Word or LibreOffice document in Chat: what it shows, wide tables, page size and look, how the assistant checks a PDF, pictures, and missing characters.
---

# Documents

Ask for a report, a letter or notes as a file and the assistant writes it into the working folder. The extension picks the format: `.pdf`, Word `.docx`, or LibreOffice `.odt` if you ask for it. Chat needs a working folder for this; see the `chat` page.

The assistant writes the whole document in one go. It can revise a document it made in the same answer, but it can't open and change one that already exists: ask again and it writes a new one.

## What a document shows

All three formats keep the shape of the assistant's markdown:

- Headings, paragraphs, **bold**, _italic_ and struck-through text. In Word and LibreOffice the headings are real headings, so the navigation pane lists them.
- Links you can click, for web and email addresses. A link to a file in the folder is written as plain text.
- Bulleted and numbered lists, nested as deep as you like, and checklists.
- Tables with a bold header row that repeats on each page. A column of numbers lines up on the right.
- Code blocks in a fixed-width font on a grey panel, and quotes beside a rule.
- Page numbers at the foot of each page. A PDF leaves them off a one-page document.

In a PDF, a heading near the bottom of a page moves to the next page with the text or table it heads. A table too wide for the page gets a landscape page of its own, with its heading. A table too wide even for that isn't written: the assistant is told how many columns fit, so it can split the table. Word and LibreOffice lay out pages themselves when you open the file. The document's title, in its properties, is its first heading unless you give it one.

## Choose the page size and look

Ask for any of these in your message and the assistant passes them along:

- **Page size**: A4 or US Letter. Without one, the document uses the paper of your system's region: Letter in the US, Canada, Mexico and a few other countries in the Americas, and A4 elsewhere.
- **Style**: _plain_ (the default), _report_ (blue headings, a rule under the title, and the title at the top of each later page), or _letter_ (wider margins, smaller headings, and no page number on the first page).
- **Title**: printed large at the top of the first page, and set in the document's properties. A first heading that repeats it is left out.
- **Contents**: a contents page after the title, listing the main sections with their page numbers. Word asks to update the document's fields when it opens the file: say yes to fill in the page numbers. In LibreOffice, use Tools → Update → Update All.

## The assistant checks its PDF

After writing a PDF, the assistant is told how many pages it came to. If the model can see images, it is also shown the pages, four to a picture, up to the first eight. It looks for a table too narrow to read, a picture missing or too small, a mostly empty page, or more pages than you asked for, and may write the document again to fix it. It can do that up to three times in one answer, even for a file that was there before and that you said to overwrite.

A model that can't see images gets only the page count.

## Pictures

Ask for a chart or a picture in the document and the assistant saves it as a PNG first (for a chart, with Python), then places it on a line of its own. PNG, JPEG and GIF work; a GIF keeps its first frame.

A picture is printed at its own size, or narrower to fit the page. Say how wide you want it, or which side it goes on, and the assistant passes that along. A picture that can't be read stops the document from being written, and the assistant is told which file it was.

## Languages and symbols

PDF text prints in Roboto, which covers the Latin, Greek and Cyrillic alphabets and most symbols. Some characters it lacks have a stand-in: an arrow `→` prints as `->`, and a tick `✓` as `[x]`.

Chinese, Japanese and Korean text and emoji don't print. The assistant is told which characters were left out, so it can rephrase or tell you. For those, ask for a `.docx` and let Word or LibreOffice choose the font.

Code blocks use Courier, which has fewer characters still: box-drawing lines in a code tree print as `+`, `-` and `|`.

Word and LibreOffice files keep every character and set the text in Calibri. Where Calibri isn't installed, LibreOffice uses Carlito, which has the same widths, if you have it, and another font if you don't.

To make a slide deck instead, see the `slides` page.
