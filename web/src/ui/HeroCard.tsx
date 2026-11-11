import { CardBase, type CardProps } from './Card';

/** The one ink card at the head of a page, holding a ring or a big number. Charts and focus rings
 *  inside it switch to their on-ink colours (components.css). */
export function HeroCard(props: CardProps) {
  return <CardBase {...props} base="hero-card" />;
}
