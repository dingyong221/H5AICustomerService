export const SOCKET_PATH: string;
export const MAX_INPUT: number;
export const MAX_OUTPUT: number;
export const MAX_TIME: number;
export const MIME_TYPES: string[];
export class ParserFailure extends Error {
  code: string;
  constructor(code: string);
}
export function validateBytes(bytes: Buffer, mime: string): void;
export interface ParserOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  concurrency?: number;
}
export function parseNative(bytes: Buffer, mime: string, options?: ParserOptions): Promise<string>;
export function parseIsolated(
  bytes: Buffer,
  mime: string,
  options?: ParserOptions,
): Promise<string>;
