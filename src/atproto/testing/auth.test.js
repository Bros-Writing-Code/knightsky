import { afterEach, describe, expect, it, vi } from 'vitest';

// auth.js imports the browser OAuth library, which needs browser globals. getProfile doesn't use it.
vi.mock('@atproto/oauth-client-browser', () => ({ BrowserOAuthClient: class {} }));

const { getProfile } = await import('../auth.js');

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getProfile', () => {
  it('returns the profile and asks the public AppView for the encoded DID', async () => {
    const profile = { handle: 'alice.bsky.social', displayName: 'Alice' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => profile });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProfile(DID)).resolves.toEqual(profile);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(DID)}`,
    );
  });

  it('throws with the HTTP status when the lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    await expect(getProfile(DID)).rejects.toThrow('Profile lookup failed (400)');
  });

  it('passes on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(getProfile(DID)).rejects.toThrow('Failed to fetch');
  });
});
