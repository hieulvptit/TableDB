import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PERSONAL_AGENTS, MAX_PERSONAL_SKILLS } from '@vnpay/shared';
import { deletePersonalSkill, flushWorkspaceForTests, getPersonalAgents, getPersonalSkills, installPersonalTemplate, reloadWorkspaceForTests, savePersonalAgent, savePersonalSkill } from '../tabledb/workspace';
import { PERSONAL_TEMPLATES } from './personalTemplates';

beforeEach(() => { localStorage.clear(); reloadWorkspaceForTests(); });
describe('personal workspace configuration', () => {
  it('persists skills, agents and toggles, and removes deleted skill bindings', async () => {
    const template = PERSONAL_TEMPLATES[0]!;
    expect(installPersonalTemplate(template.skill, template.agent)).toBe(true);
    expect(savePersonalSkill({ ...template.skill, enabled: false })).toBe(true);
    await flushWorkspaceForTests(); reloadWorkspaceForTests();
    expect(getPersonalSkills()[0]?.enabled).toBe(false);
    expect(getPersonalAgents()[0]?.skills).toContain(`personal:${template.skill.name}`);
    deletePersonalSkill(template.skill.name);
    expect(getPersonalAgents()[0]?.skills).not.toContain(`personal:${template.skill.name}`);
    await flushWorkspaceForTests(); reloadWorkspaceForTests();
    expect(getPersonalSkills()).toEqual([]);
    expect(getPersonalAgents()).toHaveLength(1);
  });

  it('bounds collections while permitting edits at capacity and does not partially install a template', () => {
    const template = PERSONAL_TEMPLATES[0]!;
    for (let i = 0; i < MAX_PERSONAL_SKILLS; i++) expect(savePersonalSkill({ ...template.skill, name: `skill-${i}` })).toBe(true);
    expect(savePersonalSkill(template.skill)).toBe(false);
    expect(savePersonalSkill({ ...template.skill, name: 'skill-0', label: 'Updated' })).toBe(true);
    expect(installPersonalTemplate(template.skill, template.agent)).toBe(false);
    expect(getPersonalAgents()).toEqual([]);
    for (let i = 0; i < MAX_PERSONAL_AGENTS; i++) expect(savePersonalAgent({ ...template.agent, name: `agent-${i}` })).toBe(true);
    expect(savePersonalAgent(template.agent)).toBe(false);
    expect(savePersonalAgent({ ...template.agent, name: 'agent-0', enabled: false })).toBe(true);
  });

  it('preserves existing definitions on template collisions and drops malformed storage entries', () => {
    const template = PERSONAL_TEMPLATES[0]!;
    savePersonalSkill({ ...template.skill, body: 'User-specific existing instructions.' });
    expect(installPersonalTemplate(template.skill, template.agent)).toBe(false);
    expect(getPersonalSkills()[0]?.body).toBe('User-specific existing instructions.');
    localStorage.setItem('tdb.ws.v1', JSON.stringify({ v: 1, personalSkills: [template.skill, template.skill, { ...template.skill, name: 'BAD NAME' }], personalAgents: [template.agent, { ...template.agent, instructions: 'short' }] }));
    reloadWorkspaceForTests();
    expect(getPersonalSkills()).toEqual([template.skill]);
    expect(getPersonalAgents()).toEqual([template.agent]);
  });
});
