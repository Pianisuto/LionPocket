/** Existing public normal Squirrel feed; never enabled for beta, portable or Linux. */
export function windowsUpdateFeed(input: {
  platform: string;
  arch: string;
  version: string;
  installed: boolean;
  beta: boolean;
  firstRun: boolean;
}): string | null {
  if (input.platform !== 'win32' || !input.installed || input.beta || input.firstRun) return null;
  return `https://update.electronjs.org/Pianisuto/LionPocket/${input.platform}-${input.arch}/${input.version}`;
}
