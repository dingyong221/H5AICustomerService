export interface GenerationCoordinator {
  assertReady(): Promise<void>;
}

export class GenerationUnavailableError extends Error {
  public constructor(reason = 'Assistant generation is not configured') {
    super(reason);
    this.name = 'GenerationUnavailableError';
  }
}

export class UnavailableGenerationCoordinator implements GenerationCoordinator {
  readonly #reason: string;

  public constructor(reason = 'Assistant generation is not configured') {
    this.#reason = reason;
  }

  public async assertReady(): Promise<never> {
    await Promise.resolve();
    throw new GenerationUnavailableError(this.#reason);
  }
}
