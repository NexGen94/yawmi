import { Card } from '../../ui/Card';
import { HeroCard } from '../../ui/HeroCard';
import { Skeleton } from '../../ui/Skeleton';

/** Placeholders with the size of the page: the ink card with its ring, the rows of habits, and the
 *  side cards, so nothing moves when the data arrives. */
export function HomeSkeleton() {
  return (
    <div class="page-cols">
      <div class="home-main">
        <HeroCard class="today-hero">
          <div class="hero-body">
            <Skeleton round blockSize="120px" inlineSize="120px" />
            <div class="hero-figures">
              <Skeleton blockSize="var(--fs-num-lg)" inlineSize="160px" />
              <Skeleton inlineSize="120px" />
            </div>
          </div>
        </HeroCard>
        <Card>
          <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
          <Skeleton blockSize="var(--hit)" />
          <Skeleton blockSize="var(--hit)" />
          <Skeleton blockSize="var(--hit)" />
          <Skeleton blockSize="var(--hit)" />
        </Card>
      </div>
      <div class="home-side">
        <Card>
          <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
          <Skeleton />
          <Skeleton inlineSize="70%" />
        </Card>
        <Card>
          <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
          <Skeleton />
          <Skeleton inlineSize="70%" />
        </Card>
      </div>
    </div>
  );
}
