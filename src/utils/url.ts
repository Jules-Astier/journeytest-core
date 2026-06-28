export function allowedOriginsFor(baseUrl: string, allowedOrigins?: string[]): string[] {
  const baseOrigin = new URL(baseUrl).origin;
  return allowedOrigins?.length ? allowedOrigins : [baseOrigin];
}

export function assertUrlAllowed(url: string, allowedOrigins: string[]): void {
  const origin = new URL(url).origin;
  if (!allowedOrigins.includes(origin)) {
    throw new Error(
      `Navigation to "${origin}" is outside allowed origins: ${allowedOrigins.join(", ")}`,
    );
  }
}
