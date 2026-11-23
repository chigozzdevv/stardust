import { Features } from '@site/components/landing/features';
import { Footer } from '@site/components/landing/footer';
import { Hero } from '@site/components/landing/hero';
import { Roadmap } from '@site/components/landing/roadmap';
import { Divider } from '@site/components/ui/divider';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />
      <Divider />
      <Features />
      <Divider />
      <Roadmap />
      <Divider />
      <Footer />
    </main>
  );
}
