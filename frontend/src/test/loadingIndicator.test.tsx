import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingIndicator } from '../components/ui/loading-indicator';

describe('LoadingIndicator', () => {
  it('announces meaningful pending text without exposing the decorative icon', () => {
    const { unmount } = render(<LoadingIndicator label="Loading details..." />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading details...');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(status.querySelector('svg')).toHaveClass('motion-reduce:animate-none');
    unmount();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
