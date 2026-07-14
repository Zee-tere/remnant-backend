import { isAllowedOrigin, parseOriginList } from './origin';

describe('origin allowlist', () => {
  const origins = parseOriginList(
    'https://remnantmarket.co',
    'https://www.remnantmarket.co, https://preview.example.com',
  );

  it('allows only configured browser origins in production', () => {
    expect(isAllowedOrigin('https://remnantmarket.co', origins)).toBe(true);
    expect(isAllowedOrigin('https://www.remnantmarket.co', origins)).toBe(true);
    expect(isAllowedOrigin('https://attacker.remnantmarket.co', origins)).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.10:3000', origins)).toBe(false);
  });

  it('allows non-browser requests and explicit development origins', () => {
    expect(isAllowedOrigin(undefined, origins)).toBe(true);
    expect(isAllowedOrigin('http://192.168.1.10:3000', origins, { allowPrivateLan: true })).toBe(true);
  });
});
