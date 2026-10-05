// Bundled, trusted skill text (skills.json). Progressive disclosure: the system prompt carries only `name: description`
// lines; load_skill returns the body on demand. Never register user-supplied text here.
import bundled from './skills.json';

export interface SkillDef { name: string; description: string; dialects?: string[]; body: string; references?: Record<string, string> }

export const BUNDLED_SKILLS = bundled as SkillDef[];

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class SkillRegistry {
  private order: string[] = [];
  private skills = new Map<string, SkillDef>();
  private loaded = new Set<string>();

  constructor(skills: SkillDef[], private dialect: string) {
    for (const s of skills) {
      if (!NAME_RE.test(s.name) || s.name.length > 64) throw new Error(`bad skill name ${s.name}`);
      if (!s.description || s.description.length > 1024) throw new Error(`bad skill description ${s.name}`);
      if (!this.skills.has(s.name)) this.order.push(s.name);
      this.skills.set(s.name, s);
    }
  }

  private visible(s: SkillDef) { return !s.dialects?.length || !this.dialect || s.dialects.includes(this.dialect); }
  names(): string[] { return this.order.filter((n) => this.visible(this.skills.get(n)!)); }
  catalog(): string { return this.names().map((n) => `- ${n}: ${this.skills.get(n)!.description}`).join('\n'); }

  load(name: string, ref: string): string {
    const s = this.skills.get(name);
    if (!s || !this.visible(s)) return `ERROR: unknown skill "${name.slice(0, 64)}". Available: ${this.names().join(', ')}`;
    const refs = s.references ?? {};
    if (ref) {
      if (Object.prototype.hasOwnProperty.call(refs, ref)) return refs[ref]!;
      return `ERROR: unknown reference. Available: ${Object.keys(refs).join(', ') || '(none)'}`;
    }
    if (this.loaded.has(name)) return `Skill ${name} is already loaded earlier in this conversation; reuse it.`;
    this.loaded.add(name);
    const keys = Object.keys(refs);
    return keys.length > 0 ? `${s.body}\n\nReferences (load_skill with ref): ${keys.join(', ')}` : s.body;
  }
}

export const bundledRegistry = (dialect: string) => new SkillRegistry(BUNDLED_SKILLS, dialect);
