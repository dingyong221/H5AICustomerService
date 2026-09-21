let accessToken: string | undefined;

export function provideWorkBuddyAccessToken(token: string): void {
  const normalized = token.trim();
  accessToken = normalized.length > 0 ? normalized : undefined;
}

export function readWorkBuddyAccessToken(): string | undefined {
  return accessToken;
}

export function clearWorkBuddyAccessToken(): void {
  accessToken = undefined;
}
