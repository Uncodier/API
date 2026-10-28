import { createAssistantStepResult } from '../step-result';

describe('standalone step result intent', () => {
  it.each([
    { status: 'completed', summary: 'Delivered the analysis.' },
    { status: 'failed', summary: 'Could not obtain required input.' },
    { status: 'needs_input', question: 'Which project should be examined?' },
  ])('records explicit %s intent without external effects', async payload => {
    const capture = createAssistantStepResult();
    expect(capture.getResult()).toBeUndefined();
    expect(await capture.tool.execute({ ...payload, thought_process: 'Brief intent' })).toMatchObject({ accepted: true });
    expect(capture.getResult()).toEqual(payload);
    const copy = capture.getResult()!;
    copy.status = 'failed';
    expect(capture.getResult()).toEqual(payload);
    expect(await capture.tool.execute(payload)).toMatchObject({ success: false, executed: false });
  });

  it.each([{}, null, { status: 'completed' }, { status: 'needs_input', summary: 'not a question' },
    { status: 'completed', summary: '', question: 'Which?' }, { status: 'done', summary: 'Done' }])(
    'rejects an invalid result without consuming the result slot: %j', async payload => {
      const capture = createAssistantStepResult();
      expect(await capture.tool.execute(payload)).toMatchObject({ success: false, executed: false });
      expect(capture.getResult()).toBeUndefined();
    });
});