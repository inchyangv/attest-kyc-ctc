import { Icon } from '@/components/ui/Icon';
import { Mark } from '@/components/ui/Logo';
import { VerificationStart } from '@/components/home/VerificationStart';
import { WalletLookup } from '@/components/home/WalletLookup';

export default function Home() {
  return (
    <>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="hero-copy">
          <div className="hero-eyebrow"><span /> IDENTITY FOR DIGITAL ASSETS</div>
          <h1 id="home-title">Verify once.<br /><span>Keep moving.</span></h1>
          <p>Identity verification and asset eligibility,<br className="hidden sm:block" /> connected to your wallet.</p>
          <a className="hero-demo-link" href="/demo">See how Proofmark works <Icon name="arrow" size={17} /></a>
          <div className="hero-privacy"><Icon name="shield" size={16} /> Your identity documents stay off-chain.</div>
          <Mark size={300} className="hero-seal" />
        </div>
        <VerificationStart />
      </section>

      <section className="home-workspace" aria-label="Verification tools">
        <WalletLookup />
        <div className="home-services">
          <a href="/screening" className="service-row">
            <span className="service-icon"><Icon name="shield" size={23} /></span>
            <span className="min-w-0 flex-1"><span className="service-title">Sanctions screening</span><span className="service-description">Check a name against global sanctions lists.</span></span>
            <Icon name="chevron" size={18} className="shrink-0 text-fg-subtle" />
          </a>
          <a href="/demo" className="service-row">
            <span className="service-icon"><Icon name="bolt" size={23} /></span>
            <span className="min-w-0 flex-1"><span className="service-title">Take a test drive</span><span className="service-description">Try a sample verification. No wallet needed.</span></span>
            <Icon name="chevron" size={18} className="shrink-0 text-fg-subtle" />
          </a>
        </div>
      </section>

      <section className="home-how" aria-labelledby="how-title">
        <div className="home-how-heading"><span className="text-xs font-medium text-mint">GETTING STARTED</span><h2 id="how-title">From identity<br className="hidden lg:block" /> to eligibility.</h2></div>
        <ol className="home-steps">
          <li><span className="step-number">01</span><div><h3>Connect your wallet</h3><p>Confirm the wallet you want to use.</p></div></li>
          <li><span className="step-number">02</span><div><h3>Verify your identity</h3><p>Complete the checks for your region.</p></div></li>
          <li><span className="step-number">03</span><div><h3>Check your eligibility</h3><p>See which asset requirements you meet.</p></div></li>
        </ol>
      </section>
    </>
  );
}
