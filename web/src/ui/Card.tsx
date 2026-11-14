import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

export interface CardProps {
  /** With a title the card is a region named by its heading. */
  title?: ComponentChildren;
  /** Heading level of the title (default 2). */
  headingLevel?: 2 | 3;
  class?: string;
  /** The id of the card, for a link that points at it. */
  id?: string;
  children: ComponentChildren;
}

/** A card on a given surface. `Card` and `HeroCard` share it; only the class differs. */
export function CardBase(props: CardProps & { base: string }) {
  const { title, headingLevel = 2, class: extra, id: cardId, children, base } = props;
  const id = useId();
  const cls = [base, extra].filter(Boolean).join(' ');
  if (title === undefined) return <div class={cls} id={cardId}>{children}</div>;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section class={cls} id={cardId} aria-labelledby={id}>
      <Heading id={id} class="card-title">
        {title}
      </Heading>
      {children}
    </section>
  );
}

/** The white card with a hairline border, for lists and numbers. */
export function Card(props: CardProps) {
  return <CardBase {...props} base="card" />;
}
