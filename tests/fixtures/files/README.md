# File-type fixtures

Small but structurally real files for the document matchers' tests. `generate.py` writes every one of them, using
only Python's standard library, and the outputs are committed so the tests never need Python. To change a fixture,
change the script and run it from anywhere:

```sh
python3 tests/fixtures/files/generate.py
```

The script is deterministic: every ZIP entry carries the earliest date the format allows, and nothing else records
when or where it ran, so running it again reproduces the committed bytes exactly. No fixture holds personal data:
the text is placeholder prose and the only document property is the title `Example`.

## Accepted

| Fixture                   | Produced by                                                                                                                                                                                                                              | Represents                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `cv.docx`                 | `zipfile`, deflated entries in the order Word writes them: `[Content_Types].xml` first, document properties last                                                                                                                         | A one-page Word document as Word saves it                                                   |
| `cv-libreoffice.docx`     | The same parts, in the order LibreOffice writes them: package relationships and properties first, `[Content_Types].xml` last                                                                                                             | The same document from another producer                                                     |
| `cv-with-comment.docx`    | `cv.docx`'s entries, with an archive comment after the end-of-central-directory record                                                                                                                                                   | An archive whose end record isn't the file's last 22 bytes                                  |
| `cv-data-descriptor.docx` | `cv.docx`'s entries written to a stream that can't seek, so each entry's sizes follow its data in a data descriptor and its local header carries none                                                                                    | An archive written on the fly, readable only from its index                                 |
| `cv.doc`                  | A hand-built version 3 compound file (512-byte sectors): `1Table`, `WordDocument`, both summary-information streams and `\x01CompObj`, small streams in the mini stream, the directory written last                                      | A Word 97–2003 document                                                                     |
| `cv-word6.doc`            | A compound file whose first directory sector holds `\x01CompObj`, `\x01Ole` and `\x05SummaryInformation`, so `WordDocument` is the first entry of the second, which the FAT chains to from a first sector written straight after the FAT | A Word 6 document, whose `WordDocument` only a reader following the directory chain finds   |
| `cv-object-pool.doc`      | As `cv-word6.doc`'s layout, with `Data`, `1Table` and an `ObjectPool` storage before `WordDocument`                                                                                                                                      | A Word 97 document with an object pool, `WordDocument` again in the second directory sector |
| `cv.odt`                  | `zipfile`: `mimetype` first, stored uncompressed with no extra field, then the deflated content, styles, meta, settings and manifest                                                                                                     | An OpenDocument text document                                                               |
| `cv.rtf`                  | Written as bytes                                                                                                                                                                                                                         | A short RTF document                                                                        |
| `notes.txt`               | About 10 KB of UTF-8 prose with accented letters and `£`, padded so the 4 KiB boundaries from either end fall inside a multi-byte character                                                                                              | Plain text long enough to be checked at both ends                                           |
| `notes.md`                | Written as UTF-8                                                                                                                                                                                                                         | A Markdown file, which is accepted as text and keeps its extension                          |
| `clip.mov`                | An `ftyp` atom with the `qt  ` brand, then `wide` and `mdat` atoms                                                                                                                                                                       | A QuickTime movie as a recent camera writes it                                              |
| `legacy.mov`              | `wide`, `mdat` and `moov` atoms and no `ftyp`                                                                                                                                                                                            | A QuickTime movie from before the `ftyp` atom                                               |
| `clip.mp4`                | An `ftyp` atom with major brand `isom` and compatible `iso2`, `avc1` and `mp41`, then `free` and `mdat` atoms                                                                                                                            | An MP4 video                                                                                |
| `clip.3gp`                | An `ftyp` atom with major brand `3gp4` and compatible `3gp4` and `isom`, then an `mdat` atom                                                                                                                                             | A 3GP video, which also lists an MP4 brand                                                  |
| `clip.webm`               | An EBML header with document type `webm`, then the start of a Segment                                                                                                                                                                    | A WebM video                                                                                |
| `clip.mkv`                | As `clip.webm`, with document type `matroska`                                                                                                                                                                                            | A Matroska video                                                                            |
| `photo.heic`              | An `ftyp` atom with major brand `heic` and compatible `mif1` and `heic`, then a `meta` atom                                                                                                                                              | A HEIC image, which shares its container with video                                         |
| `photo.avif`              | An `ftyp` atom with major brand `avif` and compatible `mif1`, `miaf` and `avif`, then a `meta` atom                                                                                                                                      | An AVIF image, which shares its container with video                                        |

## Refused

| Fixture                  | Produced by                                                                                                                               | Represents                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `cv.docm`                | `cv.docx`'s parts with the macro-enabled main content type and a `word/vbaProject.bin` entry, itself a compound file with a `VBA` storage | A macro-enabled Word document                                                                  |
| `book.xlsx`              | `zipfile`: workbook, one worksheet and their relationships                                                                                | An Excel workbook, a ZIP that isn't Word                                                       |
| `slides.pptx`            | `zipfile`: presentation, one slide, its layout, master and theme                                                                          | A PowerPoint presentation, a ZIP that isn't Word                                               |
| `plain.zip`              | `zipfile`: two text files                                                                                                                 | An archive that isn't an office document at all                                                |
| `truncated.docx`         | The first half of `cv.docx`'s bytes                                                                                                       | A Word document cut short, with no central directory                                           |
| `book.xls`               | A hand-built compound file: `Workbook` (starting with a BIFF8 beginning-of-file record) and both summary-information streams              | An Excel 97–2003 workbook                                                                      |
| `book-with-document.xls` | `book.xls`'s `Workbook` beside an `MBD` storage holding an embedded document's `WordDocument`, `1Table` and `\x01CompObj`                 | An Excel workbook embedding a Word document, which lists a `WordDocument` stream but isn't one |
| `slides.ppt`             | A hand-built compound file: `PowerPoint Document`, `Current User` and both summary-information streams                                    | A PowerPoint 97–2003 presentation                                                              |
| `sheet.ods`              | As `cv.odt`, declaring `application/vnd.oasis.opendocument.spreadsheet`                                                                   | Another OpenDocument type                                                                      |
| `template.ott`           | As `cv.odt`, declaring `application/vnd.oasis.opendocument.text-template`, which starts with the text type                                | The near miss for a prefix comparison                                                          |
| `utf16.txt`              | UTF-16LE with a byte-order mark                                                                                                           | Text in an encoding other than UTF-8                                                           |

`.doc` detection reads the first two directory sectors, following the header's pointer and then the FAT's chain,
and accepts a file whose `WordDocument` stream is listed there beside no `Workbook`, `Book` or `PowerPoint Document`
stream. The Word fixtures cover `WordDocument` in either sector.

The media fixtures are headers only, a few dozen bytes each: the video and image matchers read nothing else.

Some tests derive further cases from these at run time (a long archive comment, a file cut short partway through
its directory), so the fixture set stays small.
