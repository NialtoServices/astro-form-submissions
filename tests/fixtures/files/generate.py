#!/usr/bin/env python3
"""Writes the file-type detection fixtures beside this script.

Standard library only, and deterministic: every timestamp is fixed, so running it again reproduces the
committed files byte for byte. See README.md beside it for what each fixture represents.
"""

import io
import struct
import zipfile
from pathlib import Path

OUTPUT_DIR = Path(__file__).resolve().parent

# The earliest date a ZIP entry can carry, so no fixture records when it was made.
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)

XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

# MARK: - Office Open XML

PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"
WORDPROCESSING_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PRESENTATION_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main"

WORD_MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
WORD_MACRO_MAIN_TYPE = "application/vnd.ms-word.document.macroEnabled.main+xml"


def content_types(overrides, defaults=()):
    """A `[Content_Types].xml` part: the rels and xml defaults, any extra defaults, then the overrides."""
    entries = [
        f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        f'<Default Extension="xml" ContentType="application/xml"/>',
    ]
    entries += [f'<Default Extension="{extension}" ContentType="{kind}"/>' for extension, kind in defaults]
    entries += [f'<Override PartName="{part}" ContentType="{kind}"/>' for part, kind in overrides]
    return f'{XML_DECLARATION}<Types xmlns="{CONTENT_TYPES_NAMESPACE}">{"".join(entries)}</Types>'


def relationships(targets):
    """A relationships part linking each (type, target) pair in order."""
    entries = [
        f'<Relationship Id="rId{index}" Type="{kind}" Target="{target}"/>'
        for index, (kind, target) in enumerate(targets, start=1)
    ]
    return f'{XML_DECLARATION}<Relationships xmlns="{PACKAGE_RELATIONSHIPS}">{"".join(entries)}</Relationships>'


def package_relationships(main_target):
    return relationships(
        [
            (f"{OFFICE_RELATIONSHIPS}/officeDocument", main_target),
            (f"{PACKAGE_RELATIONSHIPS}/metadata/core-properties", "docProps/core.xml"),
            (f"{OFFICE_RELATIONSHIPS}/extended-properties", "docProps/app.xml"),
        ]
    )


CORE_PROPERTIES = (
    f"{XML_DECLARATION}"
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Example</dc:title></cp:coreProperties>'
)

APP_PROPERTIES = (
    f"{XML_DECLARATION}"
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    "<Pages>1</Pages></Properties>"
)

WORD_DOCUMENT = (
    f'{XML_DECLARATION}<w:document xmlns:w="{WORDPROCESSING_NAMESPACE}"><w:body>'
    "<w:p><w:r><w:t>Curriculum vitae</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>Ten years of bookkeeping for small businesses.</w:t></w:r></w:p>"
    "<w:sectPr/></w:body></w:document>"
)

WORD_STYLES = (
    f'{XML_DECLARATION}<w:styles xmlns:w="{WORDPROCESSING_NAMESPACE}">'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'
)

WORD_SETTINGS = f'{XML_DECLARATION}<w:settings xmlns:w="{WORDPROCESSING_NAMESPACE}"><w:zoom w:percent="100"/></w:settings>'

WORD_FONT_TABLE = f'{XML_DECLARATION}<w:fonts xmlns:w="{WORDPROCESSING_NAMESPACE}"><w:font w:name="Serif"/></w:fonts>'


def word_parts(main_type=WORD_MAIN_TYPE, extra_document_relationships=(), extra_defaults=()):
    """The parts of a one-page Word document, keyed by name, before any producer has ordered them."""
    document_relationships = [
        (f"{OFFICE_RELATIONSHIPS}/styles", "styles.xml"),
        (f"{OFFICE_RELATIONSHIPS}/settings", "settings.xml"),
        (f"{OFFICE_RELATIONSHIPS}/fontTable", "fontTable.xml"),
        *extra_document_relationships,
    ]
    return {
        "[Content_Types].xml": content_types(
            [
                ("/word/document.xml", main_type),
                ("/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"),
                ("/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"),
                ("/word/fontTable.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"),
                ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
                ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
            ],
            extra_defaults,
        ),
        "_rels/.rels": package_relationships("word/document.xml"),
        "word/_rels/document.xml.rels": relationships(document_relationships),
        "word/document.xml": WORD_DOCUMENT,
        "word/styles.xml": WORD_STYLES,
        "word/settings.xml": WORD_SETTINGS,
        "word/fontTable.xml": WORD_FONT_TABLE,
        "docProps/core.xml": CORE_PROPERTIES,
        "docProps/app.xml": APP_PROPERTIES,
    }


# Word writes the content types first and the document properties last.
WORD_ORDER = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/settings.xml",
    "word/fontTable.xml",
    "docProps/core.xml",
    "docProps/app.xml",
]

# LibreOffice writes the package relationships and properties first and the content types last.
LIBREOFFICE_ORDER = [
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/fontTable.xml",
    "word/settings.xml",
    "[Content_Types].xml",
]


def entry(name, compress_type=zipfile.ZIP_DEFLATED):
    info = zipfile.ZipInfo(name, date_time=FIXED_DATE_TIME)
    info.compress_type = compress_type
    info.external_attr = 0o644 << 16
    return info


def write_archive(stream, entries, comment=b""):
    """Writes (name, bytes-or-str, compression) entries in order, as one archive with an optional comment."""
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content, compress_type in entries:
            data = content.encode("utf-8") if isinstance(content, str) else content
            with archive.open(entry(name, compress_type), "w") as target:
                target.write(data)
        archive.comment = comment


def ordered(parts, order):
    return [(name, parts[name], zipfile.ZIP_DEFLATED) for name in order]


def archive_bytes(entries, comment=b""):
    buffer = io.BytesIO()
    write_archive(buffer, entries, comment)
    return buffer.getvalue()


class WriteOnlyStream:
    """A sink that can't seek or tell, so the archive writer streams each entry and follows it with a data
    descriptor, as a writer producing an archive on the fly does."""

    def __init__(self):
        self.buffer = io.BytesIO()

    def write(self, data):
        return self.buffer.write(data)

    def flush(self):
        pass


def streamed_archive_bytes(entries):
    stream = WriteOnlyStream()
    write_archive(stream, entries)
    return stream.buffer.getvalue()


def spreadsheet_parts():
    return {
        "[Content_Types].xml": content_types(
            [
                ("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
                (
                    "/xl/worksheets/sheet1.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
                ),
                ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
                ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
            ]
        ),
        "_rels/.rels": package_relationships("xl/workbook.xml"),
        "xl/_rels/workbook.xml.rels": relationships([(f"{OFFICE_RELATIONSHIPS}/worksheet", "worksheets/sheet1.xml")]),
        "xl/workbook.xml": (
            f'{XML_DECLARATION}<workbook xmlns="{SPREADSHEET_NAMESPACE}" xmlns:r="{OFFICE_RELATIONSHIPS}">'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/worksheets/sheet1.xml": (
            f'{XML_DECLARATION}<worksheet xmlns="{SPREADSHEET_NAMESPACE}"><sheetData>'
            '<row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'
        ),
        "docProps/core.xml": CORE_PROPERTIES,
        "docProps/app.xml": APP_PROPERTIES,
    }


def presentation_parts():
    master = (
        f'{XML_DECLARATION}<p:sldMaster xmlns:p="{PRESENTATION_NAMESPACE}" xmlns:a="{DRAWING_NAMESPACE}">'
        "<p:cSld><p:spTree/></p:cSld></p:sldMaster>"
    )
    layout = (
        f'{XML_DECLARATION}<p:sldLayout xmlns:p="{PRESENTATION_NAMESPACE}" xmlns:a="{DRAWING_NAMESPACE}">'
        "<p:cSld><p:spTree/></p:cSld></p:sldLayout>"
    )
    slide = (
        f'{XML_DECLARATION}<p:sld xmlns:p="{PRESENTATION_NAMESPACE}" xmlns:a="{DRAWING_NAMESPACE}">'
        "<p:cSld><p:spTree/></p:cSld></p:sld>"
    )
    theme = f'{XML_DECLARATION}<a:theme xmlns:a="{DRAWING_NAMESPACE}" name="Example"><a:themeElements/></a:theme>'
    return {
        "[Content_Types].xml": content_types(
            [
                (
                    "/ppt/presentation.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
                ),
                ("/ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"),
                (
                    "/ppt/slideLayouts/slideLayout1.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
                ),
                (
                    "/ppt/slideMasters/slideMaster1.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
                ),
                ("/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"),
                ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
                ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
            ]
        ),
        "_rels/.rels": package_relationships("ppt/presentation.xml"),
        "ppt/presentation.xml": (
            f'{XML_DECLARATION}<p:presentation xmlns:p="{PRESENTATION_NAMESPACE}" xmlns:r="{OFFICE_RELATIONSHIPS}">'
            '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
            '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'
        ),
        "ppt/_rels/presentation.xml.rels": relationships(
            [
                (f"{OFFICE_RELATIONSHIPS}/slideMaster", "slideMasters/slideMaster1.xml"),
                (f"{OFFICE_RELATIONSHIPS}/slide", "slides/slide1.xml"),
                (f"{OFFICE_RELATIONSHIPS}/theme", "theme/theme1.xml"),
            ]
        ),
        "ppt/slides/slide1.xml": slide,
        "ppt/slides/_rels/slide1.xml.rels": relationships(
            [(f"{OFFICE_RELATIONSHIPS}/slideLayout", "../slideLayouts/slideLayout1.xml")]
        ),
        "ppt/slideLayouts/slideLayout1.xml": layout,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships(
            [(f"{OFFICE_RELATIONSHIPS}/slideMaster", "../slideMasters/slideMaster1.xml")]
        ),
        "ppt/slideMasters/slideMaster1.xml": master,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships(
            [
                (f"{OFFICE_RELATIONSHIPS}/slideLayout", "../slideLayouts/slideLayout1.xml"),
                (f"{OFFICE_RELATIONSHIPS}/theme", "../theme/theme1.xml"),
            ]
        ),
        "ppt/theme/theme1.xml": theme,
        "docProps/core.xml": CORE_PROPERTIES,
        "docProps/app.xml": APP_PROPERTIES,
    }


# MARK: - OpenDocument


def open_document_bytes(mimetype, body):
    """An OpenDocument package: `mimetype` first, stored and without an extra field, then the deflated parts."""
    office = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    manifest_namespace = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
    content = (
        f'{XML_DECLARATION}<office:document-content xmlns:office="{office}" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
        f'office:version="1.3"><office:body>{body}</office:body></office:document-content>'
    )
    styles = f'{XML_DECLARATION}<office:document-styles xmlns:office="{office}" office:version="1.3"/>'
    meta = (
        f'{XML_DECLARATION}<office:document-meta xmlns:office="{office}" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3">'
        "<office:meta><dc:title>Example</dc:title></office:meta></office:document-meta>"
    )
    settings = f'{XML_DECLARATION}<office:document-settings xmlns:office="{office}" office:version="1.3"/>'
    manifest = (
        f'{XML_DECLARATION}<manifest:manifest xmlns:manifest="{manifest_namespace}" manifest:version="1.3">'
        f'<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="{mimetype}"/>'
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'
        '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>'
        '<manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>'
        "</manifest:manifest>"
    )
    return archive_bytes(
        [
            ("mimetype", mimetype, zipfile.ZIP_STORED),
            ("content.xml", content, zipfile.ZIP_DEFLATED),
            ("styles.xml", styles, zipfile.ZIP_DEFLATED),
            ("meta.xml", meta, zipfile.ZIP_DEFLATED),
            ("settings.xml", settings, zipfile.ZIP_DEFLATED),
            ("META-INF/manifest.xml", manifest, zipfile.ZIP_DEFLATED),
        ]
    )


# MARK: - Compound File Binary (OLE)

SECTOR_SIZE = 512
MINI_SECTOR_SIZE = 64
MINI_STREAM_CUTOFF = 4096
ENTRIES_PER_SECTOR = SECTOR_SIZE // 128

FREE_SECTOR = 0xFFFFFFFF
END_OF_CHAIN = 0xFFFFFFFE
FAT_SECTOR = 0xFFFFFFFD
NO_STREAM = 0xFFFFFFFF

STORAGE = 1
STREAM = 2
ROOT_STORAGE = 5
RED = 0
BLACK = 1


def compound_name_key(name):
    """The order a compound file's directory tree keeps siblings in: shorter names first, then by upper case."""
    return (len(name), name.upper())


def balanced_tree(children, depth=0):
    """Arranges sibling ids as a balanced binary search tree; returns (root id, [(id, left, right, depth)])."""
    if not children:
        return NO_STREAM, []

    middle = len(children) // 2
    left, left_nodes = balanced_tree(children[:middle], depth + 1)
    right, right_nodes = balanced_tree(children[middle + 1 :], depth + 1)
    return children[middle], [(children[middle], left, right, depth), *left_nodes, *right_nodes]


def compound_file_bytes(items, split_directory=False):
    """A version 3 compound file (512-byte sectors) holding `items`, a list of (path, data) pairs in directory
    order: a path is a tuple of names, and data is bytes for a stream or None for a storage. Streams under the
    mini stream cutoff live in the mini stream, as a real producer stores them. The directory is written last,
    so a reader has to follow the header's pointer to find it. With `split_directory`, the directory's first
    sector comes straight after the FAT and the rest are written last, so a reader has to follow the FAT's chain
    from the first directory sector to the second, as in a file a producer has rewritten in place."""
    names = ["Root Entry"] + [path[-1] for path, _data in items]
    kinds = [ROOT_STORAGE] + [STREAM if data is not None else STORAGE for _path, data in items]
    data_of = [None] + [data for _path, data in items]
    id_of_path = {(): 0}
    parent_of = [None]
    for index, (path, _data) in enumerate(items, start=1):
        id_of_path[tuple(path)] = index
        parent_of.append(id_of_path[tuple(path[:-1])])

    fat = []

    def allocate(count):
        start = len(fat)
        for offset in range(count):
            fat.append(start + offset + 1 if offset < count - 1 else END_OF_CHAIN)
        return start if count else END_OF_CHAIN

    def sectors_for(length, size=SECTOR_SIZE):
        return (length + size - 1) // size

    fat.append(FAT_SECTOR)
    first_directory_sector = allocate(1) if split_directory else None

    starts = [0] * len(names)
    sizes = [0] * len(names)
    sector_data = {}
    mini_stream = bytearray()
    mini_fat = []
    for index, data in enumerate(data_of):
        if data is None:
            continue

        sizes[index] = len(data)
        if len(data) >= MINI_STREAM_CUTOFF:
            start = allocate(sectors_for(len(data)))
            starts[index] = start
            sector_data[start] = data
        else:
            count = sectors_for(len(data), MINI_SECTOR_SIZE)
            start = len(mini_fat)
            for offset in range(count):
                mini_fat.append(start + offset + 1 if offset < count - 1 else END_OF_CHAIN)
            starts[index] = start if count else END_OF_CHAIN
            mini_stream += data + b"\0" * (count * MINI_SECTOR_SIZE - len(data))

    mini_fat_sector_count = sectors_for(len(mini_fat) * 4)
    mini_fat += [FREE_SECTOR] * (mini_fat_sector_count * SECTOR_SIZE // 4 - len(mini_fat))
    mini_fat_start = allocate(mini_fat_sector_count)
    mini_stream_start = allocate(sectors_for(len(mini_stream)))
    if mini_fat_sector_count:
        sector_data[mini_fat_start] = struct.pack(f"<{len(mini_fat)}I", *mini_fat)
        sector_data[mini_stream_start] = bytes(mini_stream)
    starts[0] = mini_stream_start
    sizes[0] = len(mini_stream)

    entry_count = sectors_for(len(names) * 128) * ENTRIES_PER_SECTOR
    directory_sector_count = entry_count // ENTRIES_PER_SECTOR
    if first_directory_sector is None:
        directory_start = allocate(directory_sector_count)
        later_directory_start = None
    else:
        directory_start = first_directory_sector
        later_directory_start = allocate(directory_sector_count - 1)
        fat[directory_start] = later_directory_start

    if len(fat) > SECTOR_SIZE // 4:
        raise ValueError("The fixture needs more than one FAT sector.")

    left = [NO_STREAM] * len(names)
    right = [NO_STREAM] * len(names)
    child = [NO_STREAM] * len(names)
    color = [BLACK] * len(names)
    for storage in [index for index, kind in enumerate(kinds) if kind != STREAM]:
        siblings = sorted(
            [index for index, parent in enumerate(parent_of) if parent == storage],
            key=lambda index: compound_name_key(names[index]),
        )
        root, nodes = balanced_tree(siblings)
        child[storage] = root
        deepest = max((depth for *_rest, depth in nodes), default=0)
        for index, left_id, right_id, depth in nodes:
            left[index] = left_id
            right[index] = right_id

            # Every path to a leaf then crosses the same number of black nodes, as the tree's colouring requires.
            color[index] = RED if depth == deepest and depth > 0 else BLACK

    directory = bytearray()
    for index in range(entry_count):
        if index >= len(names):
            directory += b"\0" * 64 + struct.pack("<HBB3I", 0, 0, 0, NO_STREAM, NO_STREAM, NO_STREAM)
            directory += b"\0" * 36 + struct.pack("<IQ", 0, 0)
            continue

        encoded = names[index].encode("utf-16-le") + b"\0\0"
        directory += encoded + b"\0" * (64 - len(encoded))
        directory += struct.pack("<HBB3I", len(encoded), kinds[index], color[index], left[index], right[index], child[index])
        directory += b"\0" * 36
        start = starts[index] if kinds[index] != STORAGE else 0
        directory += struct.pack("<IQ", start, sizes[index])
    if later_directory_start is None:
        sector_data[directory_start] = bytes(directory)
    else:
        sector_data[directory_start] = bytes(directory[:SECTOR_SIZE])
        sector_data[later_directory_start] = bytes(directory[SECTOR_SIZE:])

    fat_bytes = struct.pack(f"<{len(fat)}I", *fat) + struct.pack("<I", FREE_SECTOR) * (SECTOR_SIZE // 4 - len(fat))
    sector_data[0] = fat_bytes

    header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 16
    header += struct.pack("<HHHHH", 0x003E, 0x0003, 0xFFFE, 9, 6) + b"\0" * 6
    header += struct.pack(
        "<9I", 0, 1, directory_start, 0, MINI_STREAM_CUTOFF, mini_fat_start, mini_fat_sector_count, END_OF_CHAIN, 0
    )
    header += struct.pack("<I", 0) + struct.pack("<I", FREE_SECTOR) * 108

    body = bytearray(len(fat) * SECTOR_SIZE)
    for start, data in sector_data.items():
        body[start * SECTOR_SIZE : start * SECTOR_SIZE + len(data)] = data
    return header + bytes(body)


def padded(prefix, length):
    return prefix + b"\0" * (length - len(prefix))


# A property set stream's header with no sections: byte order, version, system and class identifiers.
PROPERTY_SET = struct.pack("<HHI16sI", 0xFFFE, 0, 0x00020006, b"\0" * 16, 0)

# A Word binary stream starts with its file information block, whose identifier is 0xA5EC.
WORD_STREAM = padded(struct.pack("<HH", 0xA5EC, 0x00C1), 4608)

# A workbook stream starts with a BIFF8 beginning-of-file record for the workbook globals.
WORKBOOK_STREAM = padded(struct.pack("<HHHHHHII", 0x0809, 16, 0x0600, 0x0005, 0, 0, 0, 0), 4096)

# A presentation stream starts with its document container's record header.
PRESENTATION_STREAM = padded(struct.pack("<HHI", 0x000F, 0x03E8, 4088), 4096)

SUMMARY_STREAMS = [
    (("\x05SummaryInformation",), PROPERTY_SET),
    (("\x05DocumentSummaryInformation",), PROPERTY_SET),
]


def word_binary_bytes():
    return compound_file_bytes(
        [
            (("1Table",), padded(b"\0", 4096)),
            (("WordDocument",), WORD_STREAM),
            *SUMMARY_STREAMS,
            (("\x01CompObj",), padded(b"\x01\0\xfe\xff", 76)),
        ]
    )


def word6_binary_bytes():
    """A Word 6 document's streams, in the order that puts `WordDocument` first in the second directory sector."""
    return compound_file_bytes(
        [
            (("\x01CompObj",), padded(b"\x01\0\xfe\xff", 76)),
            (("\x01Ole",), padded(b"\x01\0\0\x02", 20)),
            (("\x05SummaryInformation",), PROPERTY_SET),
            (("WordDocument",), WORD_STREAM),
            (("\x05DocumentSummaryInformation",), PROPERTY_SET),
        ],
        split_directory=True,
    )


def word_with_object_pool_bytes():
    """A Word 97 document whose `Data` stream, table and object pool come before `WordDocument`, pushing it into
    the second directory sector."""
    return compound_file_bytes(
        [
            (("Data",), padded(b"\0", 4096)),
            (("1Table",), padded(b"\0", 4096)),
            (("ObjectPool",), None),
            (("WordDocument",), WORD_STREAM),
            *SUMMARY_STREAMS,
            (("\x01CompObj",), padded(b"\x01\0\xfe\xff", 76)),
        ],
        split_directory=True,
    )


def workbook_binary_bytes():
    return compound_file_bytes([(("Workbook",), WORKBOOK_STREAM), *SUMMARY_STREAMS])


def presentation_binary_bytes():
    return compound_file_bytes(
        [
            (("PowerPoint Document",), PRESENTATION_STREAM),
            (("Current User",), padded(b"\x14\0\0\0", 64)),
            *SUMMARY_STREAMS,
        ]
    )


def macro_project_bytes():
    """A VBA project storage as a macro-enabled document embeds it: a `VBA` storage and a `PROJECT` stream."""
    return compound_file_bytes(
        [
            (("VBA",), None),
            (("VBA", "dir"), padded(b"\x01", 128)),
            (("VBA", "_VBA_PROJECT"), padded(b"\xcc\x61", 64)),
            (("PROJECT",), b'ID="{00000000-0000-0000-0000-000000000000}"\r\n'),
        ]
    )


# MARK: - Text


def notes_text():
    """About 10 KB of UTF-8 prose whose 4 KiB boundaries from either end fall inside multi-byte characters."""
    line = "Café opening hours, £5 entry, naïve résumé notes.\n"
    text = "\n\n" + line * 200
    for prefix in range(len(line)):
        for suffix in range(len(line)):
            data = ("Notes" + "." * prefix + text + "." * suffix + "\n").encode("utf-8")
            if data[4096] & 0xC0 == 0x80 and data[len(data) - 4096] & 0xC0 == 0x80:
                return data
    raise ValueError("No padding puts both boundaries inside a character.")


NOTES_MARKDOWN = """# Notes

- Bring the measurements for the garden wall.
- Ask about *weekend* availability.

| Item  | Cost |
| ----- | ---- |
| Paint | £40  |
"""


def main():
    word = word_parts()
    macro_parts = word_parts(
        main_type=WORD_MACRO_MAIN_TYPE,
        extra_document_relationships=[("http://schemas.microsoft.com/office/2006/relationships/vbaProject", "vbaProject.bin")],
        extra_defaults=[("bin", "application/vnd.ms-office.vbaProject")],
    )
    macro_parts["word/vbaProject.bin"] = macro_project_bytes()
    cv = archive_bytes(ordered(word, WORD_ORDER))

    fixtures = {
        "cv.docx": cv,
        "cv-libreoffice.docx": archive_bytes(ordered(word, LIBREOFFICE_ORDER)),
        "cv-with-comment.docx": archive_bytes(ordered(word, WORD_ORDER), comment=b"Exported for review."),
        "cv-data-descriptor.docx": streamed_archive_bytes(ordered(word, WORD_ORDER)),
        "cv.docm": archive_bytes(ordered(macro_parts, [*WORD_ORDER[:4], "word/vbaProject.bin", *WORD_ORDER[4:]])),
        "book.xlsx": archive_bytes([(name, data, zipfile.ZIP_DEFLATED) for name, data in spreadsheet_parts().items()]),
        "slides.pptx": archive_bytes([(name, data, zipfile.ZIP_DEFLATED) for name, data in presentation_parts().items()]),
        "plain.zip": archive_bytes(
            [
                ("readme.txt", "A plain archive of two text files.\n", zipfile.ZIP_DEFLATED),
                ("data/numbers.csv", "one,two\n1,2\n", zipfile.ZIP_DEFLATED),
            ]
        ),
        "truncated.docx": cv[: len(cv) // 2],
        "cv.doc": word_binary_bytes(),
        "cv-word6.doc": word6_binary_bytes(),
        "cv-object-pool.doc": word_with_object_pool_bytes(),
        "book.xls": workbook_binary_bytes(),
        "slides.ppt": presentation_binary_bytes(),
        "cv.odt": open_document_bytes(
            "application/vnd.oasis.opendocument.text", "<office:text><text:p>Curriculum vitae</text:p></office:text>"
        ),
        "template.ott": open_document_bytes(
            "application/vnd.oasis.opendocument.text-template",
            "<office:text><text:p>Curriculum vitae</text:p></office:text>",
        ),
        "sheet.ods": open_document_bytes(
            "application/vnd.oasis.opendocument.spreadsheet",
            '<office:spreadsheet><table:table table:name="Sheet1"/></office:spreadsheet>',
        ),
        "cv.rtf": (
            b"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Serif;}}\n"
            b"\\f0\\fs24 Curriculum vitae\\par\nTen years of bookkeeping for small businesses.\\par\n}\n"
        ),
        "notes.txt": notes_text(),
        "notes.md": NOTES_MARKDOWN.encode("utf-8"),
        "utf16.txt": b"\xff\xfe" + "Notes saved as UTF-16.\r\nCafé opening hours.\r\n".encode("utf-16-le"),
    }
    for name, data in fixtures.items():
        (OUTPUT_DIR / name).write_bytes(data)


if __name__ == "__main__":
    main()
