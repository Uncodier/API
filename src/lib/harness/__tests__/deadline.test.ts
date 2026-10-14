import { withinDeadline } from '../deadline';

it('returns normal outcomes without retrying the operation', async () => {
  const operation = jest.fn().mockResolvedValue({ ok: false });
  await expect(withinDeadline(new AbortController().signal, operation)).resolves.toEqual({ ok: false });
  expect(operation).toHaveBeenCalledTimes(1);
});
it('bounds a dependency that ignores cancellation and consumes its late rejection', async () => {
  const controller = new AbortController();
  let rejectLate!: (error: Error) => void;
  const operation = jest.fn(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
  const execution = withinDeadline(controller.signal, operation);
  await Promise.resolve(); controller.abort();
  await expect(execution).rejects.toThrow('deadline');
  rejectLate(new Error('late rejected transport'));
  await Promise.resolve();
  expect(operation).toHaveBeenCalledTimes(1);
});
it('never dispatches after cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const operation = jest.fn();
  await expect(withinDeadline(controller.signal, operation)).rejects.toThrow();
  expect(operation).not.toHaveBeenCalled();
});