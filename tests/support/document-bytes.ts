import fc from 'fast-check'

/** The bytes every ZIP archive's first local file header starts with. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/**
 * The first 52 bytes of a version 3 compound file header: the signature, a zero class id, version 3, the
 * little-endian byte-order mark, 512-byte sectors, then the counts and pointers up to the directory's first
 * sector, which the caller supplies.
 */
function compoundFileHeader(directorySector: number): number[] {
  const header = new Uint8Array(52)
  const view = new DataView(header.buffer)
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  view.setUint16(24, 0x003e, true)
  view.setUint16(26, 3, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, 9, true)
  view.setUint16(32, 6, true)
  view.setUint32(44, 1, true)
  view.setUint32(48, directorySector, true)
  return [...header]
}

/**
 * An end-of-central-directory record whose comment runs exactly to the end of the archive, pointing at a
 * directory of the given size and offset.
 */
function endOfCentralDirectory(entries: number, size: number, offset: number, comment: Uint8Array): number[] {
  const record = new Uint8Array(22)
  const view = new DataView(record.buffer)
  record.set([0x50, 0x4b, 0x05, 0x06])
  view.setUint16(8, entries, true)
  view.setUint16(10, entries, true)
  view.setUint32(12, size, true)
  view.setUint32(16, offset, true)
  view.setUint16(20, comment.length, true)
  return [...record, ...comment]
}

/**
 * `bytes` with a patterned comment of `length` bytes appended and declared by the end-of-central-directory
 * record in its last 22 bytes, where an archive without a comment keeps it. A long comment pushes the
 * central directory out of the first read of an archive's tail.
 */
function withLongComment(bytes: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(bytes.length + length)
  result.set(bytes)
  for (let index = bytes.length; index < result.length; index++) result[index] = 0x20 + (index % 64)
  if (bytes.length >= 22) new DataView(result.buffer).setUint16(bytes.length - 2, length, true)
  return result
}

/**
 * A comment-less archive whose central directory loses its last `cut` bytes, with the end record moved up to
 * meet it and declaring the shorter size, so the directory parses until its final entry runs out. Anything that
 * isn't such an archive comes back cut the same way, without a new record.
 */
function withDirectoryCutShort(archive: Uint8Array<ArrayBuffer>, cut: number): Uint8Array<ArrayBuffer> {
  const recordStart = archive.length - 22
  if (recordStart < 0) return archive

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const size = view.getUint32(recordStart + 12, true)
  const shortened = archive.slice(0, recordStart - Math.min(cut, recordStart))
  if (view.getUint32(recordStart, true) !== 0x06054b50 || cut > size) return shortened

  const result = new Uint8Array(shortened.length + 22)
  result.set(shortened)
  result.set(archive.subarray(recordStart), shortened.length)
  new DataView(result.buffer).setUint32(shortened.length + 12, size - cut, true)
  return result
}

/** `bytes` with each (position, value) pair written over it, positions wrapping round its length. */
function overwritten(bytes: Uint8Array<ArrayBuffer>, changes: [number, number][]): Uint8Array<ArrayBuffer> {
  for (const [position, value] of changes) {
    if (bytes.length > 0) bytes[position % bytes.length] = value
  }
  return bytes
}

/**
 * Bytes shaped like the containers the document matchers parse, so a property reaches past their header
 * tests: anything at all; anything after a ZIP or compound-file signature; a ZIP-like body ending in a
 * directory record that points somewhere inside it; real fixtures with bytes overwritten or cut off, cut
 * close to their end, or with a central directory cut short; and real fixtures given a comment long enough
 * to push their index past the first read, with bytes overwritten.
 *
 * @param fixtures - Well-formed files to mutate, so mutations land inside real structure.
 */
export function documentLikeBytes(fixtures: Uint8Array<ArrayBuffer>[]): fc.Arbitrary<Uint8Array<ArrayBuffer>> {
  const body = fc.uint8Array({ maxLength: 2048 })
  const overwrites = fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 })

  return fc.oneof(
    fc.uint8Array({ maxLength: 600 }),
    body.map((bytes) => Uint8Array.from([...ZIP_SIGNATURE, ...bytes])),
    fc
      .tuple(fc.integer({ min: 0, max: 24 }), fc.uint8Array({ maxLength: 8192 }))
      .map(([sector, bytes]) => Uint8Array.from([...compoundFileHeader(sector), ...bytes])),
    fc
      .tuple(
        body,
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 2200 }),
        fc.integer({ min: 0, max: 2200 }),
        fc.uint8Array({ maxLength: 40 })
      )
      .map(([bytes, entries, size, offset, comment]) =>
        Uint8Array.from([...ZIP_SIGNATURE, ...bytes, ...endOfCentralDirectory(entries, size, offset, comment)])
      ),
    fc
      .tuple(fc.constantFrom(...fixtures), overwrites, fc.option(fc.nat()))
      .map(([fixture, changes, cut]) =>
        overwritten(fixture.slice(0, cut === null ? undefined : cut % (fixture.length + 1)), changes)
      ),

    fc
      .tuple(fc.constantFrom(...fixtures), fc.integer({ min: 1, max: 2048 }))
      .map(([fixture, cut]) => fixture.slice(0, Math.max(0, fixture.length - cut))),
    fc
      .tuple(fc.constantFrom(...fixtures), fc.integer({ min: 1, max: 60 }))
      .map(([fixture, cut]) => withDirectoryCutShort(fixture, cut)),

    // Just long enough to straddle the tail read, and left whole, since a cut would drop the end record.
    fc
      .tuple(fc.constantFrom(...fixtures), fc.integer({ min: 31 * 1024, max: 33 * 1024 }), overwrites)
      .map(([fixture, length, changes]) => overwritten(withLongComment(fixture, length), changes))
  )
}
