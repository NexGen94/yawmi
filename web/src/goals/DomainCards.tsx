import { ProgressBar } from '../charts/ProgressBar';
import { Card } from '../ui/Card';
import { Code } from './Code';
import { DOMAINS } from './domains';
import { pctOrDash } from './format';
import { Iso } from './Iso';
import './DomainCards.css';

export interface DomainOutcome {
  code: string;
  title: string;
  completion: number | null;
}

export interface DomainCardsProps {
  /** `GoalsOut.outcomes` or `OverviewOut.outcomes`: only the code, the title and the completion are read. */
  outcomes: readonly DomainOutcome[];
}

/** The mean of the completions that exist, or null when none does. */
function meanOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

/** The four domains (design A8): the career, health, mind and learning cards, each with the outcomes
 *  the `DOMAINS` constant gives it, in the titles the server sent. */
export function DomainCards({ outcomes }: DomainCardsProps) {
  return (
    <div class="domain-grid">
      {DOMAINS.map((domain) => {
        const mine = domain.outcomes.flatMap((code) => outcomes.filter((o) => o.code === code));
        const mean = meanOf(mine.map((o) => o.completion));
        return (
          <Card key={domain.key} title={domain.label} headingLevel={3} class="domain-card">
            {domain.headline !== null && (
              <p class="domain-headline">
                <bdi dir="ltr">{domain.headline}</bdi>
              </p>
            )}
            <p class="domain-figure">
              <span class="num-lg">{pctOrDash(mean)}</span>
              <span class="domain-figure-note">{mine.length > 1 ? 'متوسط مخرجات المجال' : 'إنجاز المجال'}</span>
            </p>
            {mine.length === 0 ? (
              <p class="domain-none">لا مخرج لهذا المجال بعد.</p>
            ) : (
              <ul class="domain-outcomes">
                {mine.map((o) => (
                  <li key={o.code}>
                    <span class="domain-outcome-head">
                      <span class="domain-code">
                        <Code code={o.code} />
                      </span>
                      <span class="domain-title">
                        <Iso text={o.title} />
                      </span>
                      <span class="domain-pct">{pctOrDash(o.completion)}</span>
                    </span>
                    <ProgressBar value={o.completion ?? Number.NaN} label={o.title} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
