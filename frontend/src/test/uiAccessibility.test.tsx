import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../components/ui/sheet';

function NavigationSheetHarness() {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button">Open navigation</button>
      </SheetTrigger>
      <SheetContent initialFocusRef={titleRef}>
        <SheetHeader>
          <SheetTitle asChild>
            <h2 ref={titleRef} tabIndex={-1}>
              Navigation
            </h2>
          </SheetTitle>
          <SheetDescription>Choose a destination</SheetDescription>
        </SheetHeader>
        <a href="/channel/test">First destination</a>
        <SheetClose asChild>
          <button type="button">Close navigation</button>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

describe('accessible UI primitives', () => {
  it('focuses the intentional sheet heading and restores its trigger on close', async () => {
    const user = userEvent.setup();
    render(<NavigationSheetHarness />);
    const trigger = screen.getByRole('button', { name: 'Open navigation' });

    await user.click(trigger);
    expect(await screen.findByRole('heading', { name: 'Navigation' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
