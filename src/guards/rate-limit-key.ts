/** Parses an IPv6 address into its eight 16-bit groups, or `null` when it isn't one. */
function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase()

  // A trailing dotted quad (`::ffff:192.0.2.1`) stands for the last two groups.
  const dottedQuad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dottedQuad) {
    const octets = dottedQuad.slice(1).map(Number)
    if (octets.some((octet) => octet > 255)) return null

    const [first = 0, second = 0, third = 0, fourth = 0] = octets
    const high = ((first << 8) | second).toString(16)
    const low = ((third << 8) | fourth).toString(16)
    text = `${text.slice(0, dottedQuad.index)}${high}:${low}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const toGroups = (half: string | undefined) => (half ? half.split(':') : [])
  const head = toGroups(halves[0])
  const tail = toGroups(halves[1])
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null

  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill('0'), ...tail]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null

  return groups.map((group) => parseInt(group, 16))
}

/**
 * The rate-limit key for a client address: an IPv6 address is reduced to its /64 network, and an
 * IPv4-mapped IPv6 address to its IPv4 address. A host normally controls a whole /64 and can send from
 * any address in it, so keying on the full address would give it a fresh bucket per request. IPv4
 * addresses, and anything that doesn't parse, are returned unchanged.
 *
 * The default key of {@link RateLimitGuard}; use it in a custom `key` to keep the same grouping.
 *
 * @param address - The client address, as `GuardContext.clientAddress` reports it.
 * @returns The key to throttle the client under.
 */
export function rateLimitKeyForAddress(address: string): string {
  if (!address.includes(':')) return address

  // A zone index (`fe80::1%eth0`) names an interface, not part of the address.
  const groups = parseIPv6(address.replace(/%.*$/, ''))
  if (!groups) return address

  const isIPv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isIPv4Mapped) {
    const [high = 0, low = 0] = groups.slice(6)
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }

  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}
