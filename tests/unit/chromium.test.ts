import { describe, expect, it } from 'vitest';
import { installArgs } from '@/cli/browser';

describe('installArgs', () => {
  it('installs Chromium only', () => {
    expect(installArgs({})).toEqual(['install', 'chromium']);
    expect(installArgs({ CI: 'false' })).toEqual(['install', 'chromium']);
  });

  it("adds Chromium's system libraries when CI=true", () => {
    expect(installArgs({ CI: 'true' })).toEqual([
      'install',
      'chromium',
      '--with-deps',
    ]);
  });
});
