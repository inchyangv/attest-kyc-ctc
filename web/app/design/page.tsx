import type { Metadata } from 'next';
import { Button, LinkButton } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Tag, type Tone } from '@/components/ui/Tag';
import { StatCard } from '@/components/ui/StatCard';
import { Band } from '@/components/ui/Band';
import { Hash } from '@/components/ui/Hash';
import { DetailRow, DetailList } from '@/components/ui/DetailRow';
import { PageTitle, Section, Plate } from '@/components/ui/Page';
import { Icon, CreditcoinMark, type IconName } from '@/components/ui/Icon';
import { Mark, Wordmark } from '@/components/ui/Logo';
import { CREDITCOIN_EXPLORER } from '@/lib/links';

export const metadata: Metadata = { title: 'Design system' };

/* Token catalogue, kept in sync with app/globals.css by hand. */
const COLORS: { group: string; tokens: { name: string; cls: string; light: string; dark: string; note?: string }[] }[] = [
  { group: 'Canvas & surfaces', tokens: [
    { name: 'canvas', cls: 'bg-canvas', light: '#FFFFFF', dark: '#101112', note: 'page' },
    { name: 'surface', cls: 'bg-surface', light: '#F7FAFC', dark: 'white 6%', note: 'stat tiles, panels' },
    { name: 'surface-2', cls: 'bg-surface-2', light: '#EDF2F7', dark: 'white 8%', note: 'table head, chips' },
    { name: 'line', cls: 'bg-line', light: '#E2E8F0', dark: 'white 10%', note: '2px borders' },
    { name: 'divider', cls: 'bg-divider', light: 'ink 6%', dark: 'white 8%', note: '1px hairlines' },
  ]},
  { group: 'Text', tokens: [
    { name: 'fg-strong', cls: 'bg-fg-strong', light: '#101112', dark: '#FFFFFF', note: 'headings, values' },
    { name: 'fg', cls: 'bg-fg', light: 'ink 80%', dark: 'white 80%', note: 'body' },
    { name: 'fg-muted', cls: 'bg-fg-muted', light: '#718096', dark: '#A0AEC0', note: 'labels' },
    { name: 'fg-subtle', cls: 'bg-fg-subtle', light: '#A0AEC0', dark: '#718096', note: 'placeholders' },
  ]},
  { group: 'Interaction', tokens: [
    { name: 'link', cls: 'bg-link', light: '#2B6CB0', dark: '#63B3ED', note: 'links, icon buttons' },
    { name: 'accent', cls: 'bg-accent', light: '#2B6CB0', dark: '#2B6CB0', note: 'primary button' },
    { name: 'accent-tint', cls: 'bg-accent-tint', light: '#EBF8FF', dark: '#2A4365', note: 'blue tag fill' },
    { name: 'focus', cls: 'bg-focus', light: '#4299E1', dark: '#63B3ED', note: 'focus ring' },
  ]},
  { group: 'Brand', tokens: [
    { name: 'plate', cls: 'bg-plate', light: '#000000', dark: '#000000', note: 'hero plate' },
    { name: 'mint', cls: 'bg-mint', light: '#B3FCB2', dark: '#B3FCB2', note: 'only on plate' },
  ]},
  { group: 'Status', tokens: [
    { name: 'ok', cls: 'bg-ok', light: '#38A169', dark: '#38A169' },
    { name: 'ok-tint', cls: 'bg-ok-tint', light: '#F0FFF4', dark: '#22543D' },
    { name: 'warn', cls: 'bg-warn', light: '#DD6B20', dark: '#DD6B20' },
    { name: 'warn-tint', cls: 'bg-warn-tint', light: '#FFFAF0', dark: '#7B341E' },
    { name: 'bad', cls: 'bg-bad', light: '#E53E3E', dark: '#E53E3E' },
    { name: 'bad-tint', cls: 'bg-bad-tint', light: '#FFF5F5', dark: '#822727' },
    { name: 'note-tint', cls: 'bg-note-tint', light: '#FFFAF0', dark: 'orange 44%', note: 'message band' },
  ]},
];

const TYPE = [
  { name: 'Display', spec: 'Poppins 32 / 40 · 500', cls: 'font-display text-[32px] font-medium leading-10 tracking-tight text-fg-strong', sample: 'On-chain state' },
  { name: 'Plate title', spec: 'Poppins 40 / 1.1 · 600 · mint', cls: 'font-display text-[40px] font-semibold leading-tight text-mint bg-plate inline-block rounded-md px-3', sample: 'Sanctions screening' },
  { name: 'Section', spec: 'Inter 18 / 24 · 500', cls: 'text-lg font-medium leading-6 text-fg-strong', sample: 'Same mark, two policies' },
  { name: 'Body', spec: 'Inter 16 / 24 · 400', cls: 'text-base text-fg', sample: 'The mark carries the checks that were performed; each consumer decides whether that meets its own regime.' },
  { name: 'UI', spec: 'Inter 14 / 20 · 500', cls: 'text-sm font-medium text-fg-strong', sample: 'Run screening · Contract call · 0.00049 CTC' },
  { name: 'Label', spec: 'Inter 12 / 16 · 500 · muted', cls: 'text-xs font-medium text-fg-muted', sample: 'Latest block · Average block time' },
  { name: 'Mono', spec: 'SF Mono 13 · tabular', cls: 'font-mono text-[13px] text-fg-strong', sample: '0x93C62D3016123Da0aBdB4AC1857564c30CbE5629' },
];

const ICONS: IconName[] = ['shield', 'cube', 'swatch', 'database', 'bolt', 'clock', 'globe', 'gauge', 'layers', 'block', 'policy', 'wallet', 'key', 'hash', 'user', 'list', 'search', 'copy', 'check', 'x', 'info', 'warning', 'external', 'arrow', 'chevron', 'sun', 'moon', 'menu'];
const TONES: Tone[] = ['blue', 'green', 'orange', 'red', 'gray', 'mint'];

const PRINCIPLES = [
  ['Fill, don’t outline', 'Panels and stat tiles are gray.50 fills with no border. Borders are reserved for inputs (2px) and list containers (1px). Never both.'],
  ['Blue is the only action colour', 'Links, primary buttons and icon buttons are blue.600. Nothing else is blue, so the eye learns what is clickable.'],
  ['Mint lives on black', 'The Creditcoin mint (#B3FCB2) appears only as type on the black plate, never as a fill, border or tint on the canvas.'],
  ['Status is a tag', 'ALLOW / REVIEW / BLOCK, PASS / FAIL and Performed / Not run are tinted tags with dark text. No coloured borders, no shadows.'],
  ['Hashes are monospace and copyable', 'Every address and digest renders through <Hash>: truncated by default, full where it matters, linked to the explorer when it lives there.'],
  ['Same shapes make a table', 'When there is more than one row of the same shape, it is a table with a gray head. Two things being compared sit side by side.'],
  ['Silence over guesses', 'An unset bit is shown as "Not run", in muted text. The UI never implies a check that did not happen.'],
];

function Swatch({ t }: { t: (typeof COLORS)[number]['tokens'][number] }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line p-2">
      <div className={`h-10 w-10 shrink-0 rounded-sm border border-divider ${t.cls}`} />
      <div className="min-w-0 text-xs">
        <div className="font-mono text-[13px] font-medium text-fg-strong">{t.name}</div>
        <div className="text-fg-muted">{t.light} <span className="text-fg-subtle">/</span> {t.dark}</div>
        {t.note && <div className="text-fg-subtle">{t.note}</div>}
      </div>
    </div>
  );
}

export default function Design() {
  return (
    <>
      <PageTitle
        aside={<LinkButton href={CREDITCOIN_EXPLORER} target="_blank" rel="noreferrer" size="sm"><CreditcoinMark size={14} />Reference explorer<Icon name="external" size={14} /></LinkButton>}
        lede="Proofmark borrows the Creditcoin explorer's visual language: light canvas, gray fills, one blue for action, and a black plate with mint type as the single brand moment. A compliance mark should read like the chain it lives on.">
        Design system
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="swatch" label="Semantic colour tokens" value="27" sub="light + dark" />
        <StatCard icon="hash" label="Type scale" value="7" sub="styles" />
        <StatCard icon="layers" label="Radii" value="4 · 8 · 12" sub="px" />
        <StatCard icon="block" label="Primitives" value="11" sub="components" />
      </div>

      <Section title="Principles">
        <div className="grid gap-3 md:grid-cols-2">
          {PRINCIPLES.map(([h, p], i) => (
            <div key={h} className="flex gap-3 rounded-lg bg-surface p-4">
              <span className="font-mono text-[13px] text-fg-subtle">{String(i + 1).padStart(2, '0')}</span>
              <div><div className="font-medium text-fg-strong">{h}</div><p className="mt-1 text-sm text-fg-muted">{p}</p></div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Colour" lede="Chakra scale values as shipped by Blockscout. Every colour is a semantic token; components never reference raw hex.">
        <div className="grid gap-6">
          {COLORS.map(g => (
            <div key={g.group}>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{g.group}</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{g.tokens.map(t => <Swatch key={t.name} t={t} />)}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography" lede="Inter for everything, Poppins only for page and plate titles. Tabular numerals everywhere.">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th className="w-36">Style</th><th className="w-56">Spec</th><th>Sample</th></tr></thead>
            <tbody>
              {TYPE.map(t => (
                <tr key={t.name}>
                  <td className="text-fg-strong">{t.name}</td>
                  <td><span className="font-mono text-[13px] text-fg-muted">{t.spec}</span></td>
                  <td><span className={t.cls}>{t.sample}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Logo & network mark" lede="Proofmark's seal ring closes with a check. The Creditcoin mark is used only to credit the network, at 13–16px, in the text colour.">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-lg bg-surface p-5 text-fg-strong"><Mark size={40} /><Wordmark /></div>
          <Plate className="flex items-center gap-3 !p-5 text-mint"><Mark size={40} /><span className="font-display text-[17px] font-semibold text-plate-fg">Proofmark</span></Plate>
          <div className="flex items-center gap-2 rounded-lg border border-line p-5 text-sm text-fg"><CreditcoinMark size={16} className="text-fg-strong" />Built on Creditcoin</div>
        </div>
      </Section>

      <Section title="Buttons" lede="40px, 8px radius, 16/600. One primary per view. Secondary is a 2px outline, as on the explorer's Log in.">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
          <Button>Run screening</Button>
          <Button variant="secondary">Log in</Button>
          <Button variant="ghost">Advanced <Icon name="chevron" size={16} /></Button>
          <Button disabled>Screening…</Button>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="secondary"><Icon name="copy" size={16} />Copy</Button>
        </div>
      </Section>

      <Section title="Tags" lede={'14/500, 4px radius, tinted fill with a darker text of the same hue. `mono` for hex, `size="lg"` for a verdict.'}>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-4">
          {TONES.map(t => <Tag key={t} tone={t}>{t === 'blue' ? 'Contract call' : t === 'green' ? 'ALLOW' : t === 'orange' ? 'REVIEW' : t === 'red' ? 'BLOCK' : t === 'gray' ? 'Not run' : 'Testnet'}</Tag>)}
          <Tag tone="gray" mono>0x19003f</Tag>
          <Tag tone="blue">Sanctions screened</Tag>
          <Tag tone="green">Performed</Tag>
          <Tag tone="green" size="lg">PASS</Tag>
          <Tag tone="red" size="lg">FAIL</Tag>
        </div>
      </Section>

      <Section title="Inputs" lede="40px, 2px gray.200 border, blue.400 on focus. Labels sit above in 12/500 muted; hints right-aligned.">
        <div className="grid max-w-2xl gap-3 rounded-lg bg-surface p-4 sm:grid-cols-2">
          <Field label="Full name"><Input defaultValue="박서준" /></Field>
          <Field label="Date of birth" hint="YYYY-MM-DD"><Input placeholder="1990-05-05" /></Field>
          <Field label="Wallet address" hint="optional"><Input placeholder="0x…" className="font-mono" /></Field>
          <Field label="Disabled"><Input disabled value="—" readOnly /></Field>
        </div>
      </Section>

      <Section title="Stat tiles" lede="gray.50 fill, icon, 12px label, 18px value with an optional unit.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon="block" label="Latest block" value="4,211,073" />
          <StatCard icon="clock" label="Average block time" value="15.0s" />
          <StatCard icon="database" label="Entries loaded" value="23,117" sub="3 lists" />
          <StatCard icon="shield" label="Last decision" value={<Tag tone="red">BLOCK</Tag>} sub="risk 5/5" />
        </div>
      </Section>

      <Section title="Bands" lede="The explorer's message strip. One line, an icon, a tone.">
        <div className="grid gap-2">
          <Band tone="note">scanning new transactions…</Band>
          <Band tone="info">Read live from Creditcoin CC3 Testnet at block 4,211,073.</Band>
          <Band tone="ok"><b className="mr-2">ALLOW</b>No corroborated match. The mark may carry the sanctions bit.</Band>
          <Band tone="warn"><b className="mr-2">REVIEW</b>A candidate matched, but nothing corroborates it.</Band>
          <Band tone="bad"><b className="mr-2">BLOCK</b>A listed party was corroborated. No mark is issued.</Band>
        </div>
      </Section>

      <Section title="Table" lede="Gray head with rounded top corners, 14/500 cells, 1px hairlines. Numbers right-aligned and tabular.">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Policy</th><th>requireAll</th><th className="num">Min assurance</th><th>Result</th></tr></thead>
            <tbody>
              <tr><td className="text-fg-strong">KR VASP production</td><td><Tag tone="gray" mono>0x10024</Tag></td><td className="num">2</td><td><Tag tone="red">FAIL</Tag></td></tr>
              <tr><td className="text-fg-strong">KR pilot</td><td><Tag tone="gray" mono>0x10000</Tag></td><td className="num">1</td><td><Tag tone="green">PASS</Tag></td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Detail rows" lede="Explorer detail page rows: 160px muted label, hairline separators, hashes copyable.">
        <DetailList className="rounded-lg border border-line px-4">
          <DetailRow label="Subject" hint="The wallet the mark is bound to"><Hash value="0xFD1222e35a536A62f180aA44826656940e86bD5E" full /></DetailRow>
          <DetailRow label="Status"><Tag tone="green">ACTIVE</Tag></DetailRow>
          <DetailRow label="Methods"><span className="flex flex-wrap gap-1.5"><Tag tone="gray" mono>0x19003f</Tag><Tag tone="blue">Sanctions screened</Tag><Tag tone="blue">Jurisdiction check</Tag></span></DetailRow>
          <DetailRow label="Truncated"><Hash value="0xe0f8f6d4a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7" /></DetailRow>
        </DetailList>
      </Section>

      <Section title="Plate" lede="The one brand moment. Black, 12px radius, mint Poppins title, 64% white copy, hairline chips.">
        <Plate>
          <div className="text-xs font-medium uppercase tracking-wider text-plate-muted">Proofmark</div>
          <div className="mt-2 font-display text-[32px] font-semibold leading-tight text-mint">Prove compliance once.</div>
          <p className="mt-2 max-w-xl text-base text-plate-muted">Issued on Ethereum, verified on Creditcoin by Attestcoin. Zero bytes of PII on-chain.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {['OFAC SDN', 'UN Consolidated', 'EU FSF'].map(l => (
              <span key={l} className="rounded-md border border-plate-line px-3 py-1.5 text-sm text-plate-fg">{l}</span>
            ))}
          </div>
        </Plate>
      </Section>

      <Section title="Icons" lede="24px outline, 1.75 stroke, round joins. Inherit currentColor; muted in nav, strong in stat tiles.">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7 lg:grid-cols-10">
          {ICONS.map(n => (
            <div key={n} className="flex flex-col items-center gap-1.5 rounded-md bg-surface py-3 text-fg-strong">
              <Icon name={n} /><span className="font-mono text-[11px] text-fg-muted">{n}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
