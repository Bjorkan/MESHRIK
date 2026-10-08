import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsolePane } from '../components/repeater/RepeaterConsolePane';

describe('ConsolePane', () => {
  it('disables text transformations for case-sensitive CLI commands', () => {
    render(<ConsolePane history={[]} loading={false} onSend={vi.fn()} />);

    const input = screen.getByLabelText('Console command');
    expect(input).toHaveAttribute('autocapitalize', 'none');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });
});
