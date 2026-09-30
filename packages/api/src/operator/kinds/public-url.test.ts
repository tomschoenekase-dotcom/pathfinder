import { describe, expect, it } from 'vitest'

import { assertPublicHttpsUrl, OperatorUrlError } from './public-url'

describe('assertPublicHttpsUrl', () => {
  it('accepts public https URLs, including other ports', () => {
    expect(assertPublicHttpsUrl('https://www.example.com/menu').hostname).toBe('www.example.com')
    expect(assertPublicHttpsUrl('https://www.example.com:8443/a').port).toBe('8443')
    expect(assertPublicHttpsUrl('https://93.184.216.34/').hostname).toBe('93.184.216.34')
  })

  it.each([
    'http://www.example.com/',
    'ftp://www.example.com/',
    'https://user:pw@www.example.com/',
    'https://user@www.example.com/',
    'https://localhost/',
    'https://app.localhost/',
    'https://intranet/',
    'https://printer.local/',
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://172.16.0.1/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://[fd00::1]/',
    'https://[::ffff:10.0.0.1]/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow(OperatorUrlError)
  })
})
