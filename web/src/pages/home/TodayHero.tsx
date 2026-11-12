import { Ring } from '../../charts/Ring';
import { fmt } from '../../lib/format';
import { HeroCard } from '../../ui/HeroCard';
import { LinkButton } from './LinkButton';

export interface TodayHeroProps {
  done: number;
  due: number;
}

/** The ink card at the head of the page: today's habits done, as a ring and as «3 من 6». With no
 *  habit due it says so and offers the action that fills the page. */
export function TodayHero({ done, due }: TodayHeroProps) {
  return (
    <HeroCard title="عادات اليوم" class="today-hero">
      {due > 0 ? (
        <div class="hero-body">
          <Ring value={done / due} label="إنجاز اليوم" size={120} />
          <div class="hero-figures">
            <p class="hero-count">{`${fmt.num(done)} من ${fmt.num(due)}`}</p>
            <p class="hero-note">عادات منجزة اليوم</p>
          </div>
        </div>
      ) : (
        <div class="state-message">
          <p class="state-text">لا عادات مستحقة اليوم</p>
          <LinkButton href="/habits/new">عادة جديدة</LinkButton>
        </div>
      )}
    </HeroCard>
  );
}
