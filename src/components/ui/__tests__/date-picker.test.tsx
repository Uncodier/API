import { DatePicker } from '../date-picker';
import type { ChangeEvent, InputHTMLAttributes, ReactElement } from 'react';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useSyncExternalStore: jest.fn((_subscribe, getSnapshot) => getSnapshot()),
}));

describe('DatePicker', () => {
  it('displays ISO values in the native date input format', () => {
    const input = DatePicker({
      name: 'date',
      value: '2026-10-03T00:00:00.000Z',
      onChange: jest.fn(),
    }) as ReactElement<InputHTMLAttributes<HTMLInputElement>>;

    expect(input.props.name).toBe('date');
    expect(input.props.value).toBe('2026-10-03');
  });

  it('emits UTC ISO dates and null when cleared', () => {
    const onChange = jest.fn();
    const input = DatePicker({ name: 'date', onChange }) as ReactElement<
      InputHTMLAttributes<HTMLInputElement>
    >;

    input.props.onChange?.({ target: { value: '2026-10-03' } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith('2026-10-03T00:00:00.000Z');
    input.props.onChange?.({ target: { value: '' } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});