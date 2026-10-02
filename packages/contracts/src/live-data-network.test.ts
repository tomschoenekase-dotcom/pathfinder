import { describe, expect, it } from 'vitest'

import { isPublicIpAddress } from './live-data-network'

describe('isPublicIpAddress', () => {
  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
  ])('treats %s as public', (address) => {
    expect(isPublicIpAddress(address)).toBe(true)
  })

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::10.0.0.1',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '2001::1',
    'ff02::1',
    'not-an-ip',
    '999.1.1.1',
    '',
  ])('treats %s as non-public', (address) => {
    expect(isPublicIpAddress(address)).toBe(false)
  })
})
