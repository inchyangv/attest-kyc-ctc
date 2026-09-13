import { createHash } from 'node:crypto';

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface LockPackage { name?: string; version?: string; resolved?: string; integrity?: string; license?: string; link?: boolean; inBundle?: boolean;
  dev?: boolean; optional?: boolean; hasInstallScript?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
interface Lock { lockfileVersion: number; packages: Record<string, LockPackage> }

/** Resolution metadata inventory, not proof of installed/bundled bytes or legal compliance. */
export function inspectLock(value: unknown) {
  const lock = value as Lock;
  if (lock?.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) throw new Error('lockfile v3 with root package required');
  const issues: string[] = [];
  const packages = Object.entries(lock.packages).filter(([path]) => path !== '').sort(([a], [b]) => a.localeCompare(b)).map(([path, p]) => {
    if (!path.startsWith('node_modules/') || path.includes('..') || p.link || !p.version) issues.push(`unsupported package location/version: ${path}`);
    let enclosingTarball: string | null = null;
    if (p.inBundle) {
      let parent = path;
      while (parent.lastIndexOf('/node_modules/') >= 0) {
        parent = parent.slice(0, parent.lastIndexOf('/node_modules/'));
        if (lock.packages[parent]?.integrity) { enclosingTarball = parent; break; }
      }
      if (!enclosingTarball) issues.push(`bundled package lacks enclosing tarball: ${path}`);
    } else {
      try {
        const url = new URL(p.resolved ?? '');
        if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) issues.push(`unapproved registry resolution: ${path}`);
      } catch { issues.push(`missing/invalid resolution: ${path}`); }
      if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(p.integrity ?? '') || Buffer.from((p.integrity ?? '').slice(7), 'base64').length !== 64) issues.push(`missing/invalid SHA-512 integrity: ${path}`);
    }
    if (!p.license) issues.push(`license metadata missing: ${path}`);
    return { path, name: p.name ?? path.slice(path.lastIndexOf('node_modules/') + 13), version: p.version ?? null,
      license: p.license ?? null, dev: Boolean(p.dev), optional: Boolean(p.optional), installScript: Boolean(p.hasInstallScript),
      integrity: p.integrity ?? null, enclosingTarball };
  });
  const direct = Object.entries({ ...lock.packages[''].dependencies, ...lock.packages[''].devDependencies }).map(([name, requested]) => {
    const p = lock.packages[`node_modules/${name}`];
    if (!p?.version) issues.push(`missing direct dependency: ${name}`);
    return { name, requested, resolvedVersion: p?.version ?? null };
  });
  return { packages, direct, issues };
}

export function assertSourceBaseline(expected: Record<string, string>, actual: Record<string, string>) {
  if (!Object.keys(expected).length) throw new Error('empty source baseline');
  for (const [path, digest] of Object.entries(expected)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || actual[path] !== digest) throw new Error(`source changed or missing; explicit upstream-diff review required: ${path}`);
  }
}

export function assertActionPins(workflow: string) {
  const approved: Record<string, string> = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact': 'b7c566a772e6b6bfb58ed0dc250532a479d7789f',
    'foundry-rs/foundry-toolchain': '908c540300062bd5a7e473851cdb4282204cee09',
  };
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*/gm)].map(m => m[1]);
  if (!uses.length) throw new Error('no workflow action references found');
  for (const use of uses) {
    const [name, commit, ...extra] = use.split('@');
    if (extra.length || !/^[a-f0-9]{40}$/.test(commit ?? '') || approved[name] !== commit) throw new Error(`unreviewed or floating action reference: ${use}`);
  }
}

export interface BomComponent { name: string; version: string; scope?: string; licenses?: { expression?: string; license?: { id?: string; name?: string } }[];
  properties?: { name: string; value: string }[] }
export function sbomSummary(bom: { bomFormat?: string; specVersion?: string; components?: BomComponent[]; dependencies?: unknown[] }) {
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5' || !Array.isArray(bom.components) || !bom.components.length || !Array.isArray(bom.dependencies)) throw new Error('unsupported or empty npm SBOM');
  const licenses = (c: BomComponent) => (c.licenses ?? []).map(l => l.expression ?? l.license?.id ?? l.license?.name ?? 'UNKNOWN');
  return { specVersion: bom.specVersion, componentCount: bom.components.length, dependencyNodeCount: bom.dependencies.length,
    missingLicense: bom.components.filter(c => !c.licenses?.length).map(c => `${c.name}@${c.version}`),
    licenseReview: bom.components.filter(c => licenses(c).some(l => !['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0'].includes(l)))
      .map(c => ({ name: c.name, version: c.version, licenses: licenses(c), scope: c.scope,
        development: c.properties?.some(p => p.name === 'cdx:npm:package:development' && p.value === 'true') ?? false })) };
}
