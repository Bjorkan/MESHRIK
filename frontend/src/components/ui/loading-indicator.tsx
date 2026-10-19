import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Indeterminate work: the label remains useful with motion disabled. */
export function LoadingIndicator({ label, className }: { label: string; className?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('inline-flex min-w-0 items-center justify-center gap-2', className)}
    >
      <LoaderCircle
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span>{label}</span>
    </span>
  );
}
