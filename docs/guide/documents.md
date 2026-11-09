---
title: Documents
description: Making a PDF, Word or LibreOffice document in Chat: what a PDF shows, wide tables, page size and look, how the assistant checks it, pictures, missing characters, and .docx and .odt.
---

# Documents

Ask for a report, a letter or notes as a file and the assistant writes it into the working folder. The extension picks the format: `.pdf`, Word `.docx`, or LibreOffice `.odt` if you ask for it. Chat needs a working folder for this; see the `chat` page.

The assistant writes the whole document in one go. It can revise a document it made in the same answer, but it can't open and change one that already exists: ask again and it writes a new one.

## What a PDF shows

A PDF keeps the shape of the assistant's markdown:

- Headings, paragraphs, **bold**, _italic_ and struck-through text.
- Links you can click, for web and email addresses. A link to a file in the folder prints as plain text.
- Bulleted and numbered lists, nested as deep as you like, and checklists.
- Tables with a bold header row that repeats on each page. A column of numbers lines up on the right.
- A table too wide for the page gets a landscape page of its own, with its heading. A table too wide even for that isn't written: the assistant is told how many columns fit, so it can split the table.
- Code blocks in a fixed-width font on a grey panel, and quotes beside a rule.
- Page numbers at the foot of each page when there is more than one.

A heading near the bottom of a page moves to the next page with the text or table it heads. The PDF's title, in its properties, is the document's first heading unless you give it one.

## Choose the page size and look

Ask for any of these in your message and the assistant passes them along:

- **Page size**: A4 or US Letter. Without one, the PDF uses the paper of your system's region: Letter in the US, Canada, Mexico and a few other countries in the Americas, and A4 elsewhere.
- **Style**: _plain_ (the default), _report_ (blue headings, a rule under the title, and the title at the top of each later page), or _letter_ (wider margins, smaller headings, and no page number on the first page).
- **Title**: printed large at the top of the first page, and set in the PDF's properties. A first heading that repeats it is left out.
- **Contents**: a contents page after the title, listing the main sections with their page numbers.

These apply to PDFs only.

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

## Word and LibreOffice files

`.docx` and `.odt` files take headings, paragraphs and pictures. Other markdown, such as `**bold**`, list dashes and table rows, is written as it was typed, so ask for a PDF when those matter.

To make a slide deck instead, see the `slides` page.
