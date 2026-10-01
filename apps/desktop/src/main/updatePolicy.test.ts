import { describe, expect, it } from 'vitest';
import { windowsUpdateFeed } from './updatePolicy';
const installed = { platform: 'win32', arch: 'x64', version: '0.3.10', installed: true, beta: false, firstRun: false };
describe('release channel update boundaries', () => {
  it('keeps the existing normal Squirrel feed', () => {
    expect(windowsUpdateFeed(installed)).toBe('https://update.electronjs.org/Pianisuto/LionPocket/win32-x64/0.3.10');
  });
  it.each([{ beta: true }, { installed: false }, { firstRun: true }, { platform: 'linux' }])('does not cross channels or enable unsupported update infrastructure %#', fields => {
    expect(windowsUpdateFeed({ ...installed, ...fields })).toBeNull();
  });
});
