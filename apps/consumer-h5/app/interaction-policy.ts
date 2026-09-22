const pollIntervalMilliseconds = 1_000;
const maximumPollIntervalMilliseconds = 5_000;

export function pollDelayMilliseconds(completedPolls: number): number {
  return Math.min(
    pollIntervalMilliseconds * 2 ** Math.floor(Math.max(0, completedPolls) / 10),
    maximumPollIntervalMilliseconds,
  );
}

export function shouldSubmitComposerKey(input: {
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
}): boolean {
  return input.key === 'Enter' && !input.isComposing && (input.ctrlKey || input.metaKey);
}
