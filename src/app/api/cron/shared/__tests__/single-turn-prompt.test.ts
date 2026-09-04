import { describe, expect, it } from '@jest/globals';
import { firstActionsPromptLine } from '../step-git-prompts';

describe('firstActionsPromptLine', () => {
  it('does not require skill_lookup first on investigate/append steps', () => {
    const line = firstActionsPromptLine('investigate');
    expect(line).toContain('webSearch');
    expect(line).not.toContain('MANDATORY ORDER');
    expect(line.toLowerCase()).toContain('do not call skill_lookup first');
  });

  it('keeps skill_lookup first for coding roles', () => {
    expect(firstActionsPromptLine('frontend')).toContain('skill_lookup');
  });
});
