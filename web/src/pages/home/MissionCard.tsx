import type { ComponentChildren } from 'preact';

import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

export interface MissionCardProps {
  mission: string;
  vision: string;
  /** The settings are still being read. */
  loading?: boolean;
  /** The settings could not be read, and no saved copy exists. */
  unavailable?: boolean;
}

function Piece({ name, text }: { name: string; text: string }) {
  return (
    <div class="mission-piece">
      <h3 class="mission-name">{name}</h3>
      {/* the person's own words, as written: line breaks and spaces kept, nothing added or changed */}
      {text === '' ? <p class="mission-empty">{`(${name})`}</p> : <p class="mission-text">{text}</p>}
    </div>
  );
}

/** «رسالتي» and «رؤيتي»: shown exactly as the person wrote them in the settings, or an empty pair of
 *  brackets with the way to write them. Nothing here is generated, suggested or reworded. */
export function MissionCard({ mission, vision, loading = false, unavailable = false }: MissionCardProps) {
  const empty = mission === '' || vision === '';
  let body: ComponentChildren;
  if (loading) {
    body = (
      <>
        <Skeleton />
        <Skeleton inlineSize="70%" />
      </>
    );
  } else if (unavailable) {
    body = <p class="mission-empty">تعذّرت القراءة الآن.</p>;
  } else {
    body = (
      <>
        <Piece name="رسالتي" text={mission} />
        <Piece name="رؤيتي" text={vision} />
        {empty && (
          <a class="mission-link" href="/settings">
            كتابتهما من الإعدادات
          </a>
        )}
      </>
    );
  }
  return (
    <Card title="رسالتي ورؤيتي" class="mission-card">
      {body}
    </Card>
  );
}
