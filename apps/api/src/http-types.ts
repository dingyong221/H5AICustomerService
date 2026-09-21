export type RequestWithId = Readonly<{
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  method?: string;
  requestId?: string;
  url?: string;
}>;

export type MutableRequestWithId = {
  -readonly [Key in keyof RequestWithId]: RequestWithId[Key];
};

export type ResponseLike = {
  setHeader: (name: string, value: string) => void;
  status: (statusCode: number) => ResponseLike;
  json: (body: unknown) => unknown;
};
