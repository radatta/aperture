import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../../lib/cx';
import { parseNotes } from './parseNotes';
import type { Inline } from './parseNotes';

// Renders parsed notes as React elements — text is always a child, never markup, so a note can't
// inject HTML. Links open in a new tab without handing the opener over.
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text':
        return n.text;
      case 'strong':
        return (
          <strong key={i} className="font-semibold">
            {renderInline(n.children)}
          </strong>
        );
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>;
      case 'code':
        return (
          <code key={i} className="rounded bg-panel-2 px-1 font-mono text-[0.9em]">
            {n.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal underline underline-offset-2"
          >
            {n.text}
          </a>
        );
    }
  });
}

// The rendered note. overflow-wrap:anywhere keeps a long URL from pushing the modal sideways on a phone.
export function NotesView({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseNotes(source), [source]);
  return (
    <div className={cx('flex flex-col gap-2 text-sm text-ink [overflow-wrap:anywhere]', className)}>
      {blocks.map((b, i) => {
        if (b.kind === 'p')
          return (
            <p key={i}>
              {b.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {renderInline(line)}
                </span>
              ))}
            </p>
          );
        const items = b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
        return b.kind === 'ul' ? (
          <ul key={i} className="list-disc pl-5">
            {items}
          </ul>
        ) : (
          <ol key={i} start={b.start} className="list-decimal pl-5">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
