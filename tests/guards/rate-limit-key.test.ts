import { rateLimitKeyForAddress } from '#guards/rate-limit-key.js'
import { describe, expect, it } from 'vitest'

describe('rateLimitKeyForAddress', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(rateLimitKeyForAddress('192.0.2.1')).toBe('192.0.2.1')
  })

  it.each([
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:DB8:85A3:08D3:ffff:ffff:ffff:ffff', '2001:db8:85a3:8d3::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64']
  ])('groups %s by its /64', (address, key) => {
    expect(rateLimitKeyForAddress(address)).toBe(key)
  })

  it('gives every address in one /64 the same key', () => {
    const keys = new Set(
      ['2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2:ffff::'].map(rateLimitKeyForAddress)
    )

    expect(keys.size).toBe(1)
  })

  it.each([
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:c000:0201', '192.0.2.1']
  ])('reduces the IPv4-mapped address %s to IPv4', (address, key) => {
    expect(rateLimitKeyForAddress(address)).toBe(key)
  })

  it.each(['not-an-address', '1:2:3', '1::2::3', '::ffff:999.0.0.1', 'gggg::1'])(
    'returns %s unchanged when it does not parse',
    (address) => {
      expect(rateLimitKeyForAddress(address)).toBe(address)
    }
  )
})
