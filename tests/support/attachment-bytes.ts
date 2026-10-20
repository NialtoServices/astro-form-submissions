import fc from 'fast-check'

/**
 * Byte arrays to attach to an email: mostly short, with lengths around the multiples of three and of 32 KiB where
 * base64 padding and a chunked encoder's boundaries fall, which pure chance would rarely reach.
 */
export const attachmentBytes: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 3, arbitrary: fc.uint8Array({ maxLength: 40 }) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(32_765, 32_766, 32_767, 32_768, 32_769, 65_532, 65_533, 65_534, 65_535, 65_536, 65_537)
      .chain((length) => fc.uint8Array({ minLength: length, maxLength: length }))
  }
)
