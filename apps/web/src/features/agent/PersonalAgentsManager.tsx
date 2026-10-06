import { useState } from 'react';
import { PersonalAgent, PersonalSkill } from '@vnpay/shared';
import { Button, Checkbox, EmptyState } from '@vnpay/ui';
import { t } from '../../i18n';
import { Icon } from '../tabledb/icons';
import { deletePersonalAgent, deletePersonalSkill, installPersonalTemplate, savePersonalAgent, savePersonalSkill, usePersonalAgents, usePersonalSkills } from '../tabledb/workspace';
import { BUNDLED_SKILLS } from './harness/skills';
import { PERSONAL_TEMPLATES } from './personalTemplates';

type Editor = { kind: 'skill'; original?: string; value: PersonalSkill } | { kind: 'agent'; original?: string; value: PersonalAgent };

export function PersonalAgentsManager({ dialect }: { dialect?: string }) {
  const skills = usePersonalSkills(), agents = usePersonalAgents();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const edit = (value: Editor) => { setEditor(value); setError(''); setNotice(''); };
  const patch = (values: Record<string, unknown>) => setEditor((cur) => cur ? { ...cur, value: { ...cur.value, ...values } } as Editor : null);
  const save = () => {
    if (!editor) return;
    const parsed = editor.kind === 'skill' ? PersonalSkill.safeParse(editor.value) : PersonalAgent.safeParse(editor.value);
    if (!parsed.success) { setError(t('personal.invalid')); return; }
    const duplicate = (editor.kind === 'skill' ? skills : agents).some((s) => s.name === editor.value.name && s.name !== editor.original);
    if (duplicate) { setError(t('personal.duplicate')); return; }
    const ok = editor.kind === 'skill' ? savePersonalSkill(editor.value) : savePersonalAgent(editor.value);
    if (!ok) { setError(t('personal.full')); return; }
    setEditor(null); setError(''); setNotice(t('personal.saved'));
  };
  const selectedSkills = editor?.kind === 'agent' ? editor.value.skills : [];
  const bindings = [
    ...BUNDLED_SKILLS.filter((s) => !dialect || !s.dialects?.length || s.dialects.includes(dialect)).map((s) => ({ name: s.name, label: s.name })),
    ...skills.filter((s) => s.enabled).map((s) => ({ name: `personal:${s.name}`, label: s.label })),
  ];
  return (
    <div className="ui-col" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, gap: 10 }}>
      <p className="ui-muted" style={{ margin: 0 }}>{t('personal.hint')}</p>
      <div className="ui-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Button size="sm" onClick={() => edit({ kind: 'skill', value: { name: '', label: '', description: '', body: '', enabled: true } })}>{t('personal.newSkill')}</Button>
        <Button size="sm" onClick={() => edit({ kind: 'agent', value: { name: '', label: '', description: '', instructions: '', skills: [], enabled: true, useOpenMetadata: false } })}>{t('personal.newAgent')}</Button>
      </div>
      {error && <div className="ui-error-text" role="alert">{error}</div>}
      {notice && <div role="status">{notice}</div>}
      {editor ? (
        <form className="ui-col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <strong>{t(editor.kind === 'skill' ? 'personal.skillEditor' : 'personal.agentEditor')}</strong>
          <label className="ui-col">{t('personal.name')}<input className="ui-input" required maxLength={48} pattern="[a-z0-9]+(-[a-z0-9]+)*" disabled={!!editor.original} value={editor.value.name} onChange={(e) => patch({ name: e.target.value })} /></label>
          <small className="ui-muted">{t('personal.nameHint')}</small>
          <label className="ui-col">{t('personal.label')}<input className="ui-input" required maxLength={80} value={editor.value.label} onChange={(e) => patch({ label: e.target.value })} /></label>
          <label className="ui-col">{t('personal.description')}<textarea className="ui-input" required maxLength={400} rows={2} value={editor.value.description} onChange={(e) => patch({ description: e.target.value })} /></label>
          <label className="ui-col">{t('personal.instructions')}<textarea className="ui-input" required minLength={10} maxLength={editor.kind === 'skill' ? 8000 : 6000} rows={7} value={editor.kind === 'skill' ? editor.value.body : editor.value.instructions} onChange={(e) => patch(editor.kind === 'skill' ? { body: e.target.value } : { instructions: e.target.value })} /></label>
          {editor.kind === 'agent' && (
            <>
              <fieldset style={{ border: '1px solid var(--ui-border)', borderRadius: 6 }}>
                <legend>{t('personal.bindings')}</legend>
                <div className="ui-col" style={{ maxHeight: 180, overflow: 'auto', gap: 4 }}>
                  {bindings.map((s) => <Checkbox key={s.name} label={s.label} checked={selectedSkills.includes(s.name)} disabled={!selectedSkills.includes(s.name) && selectedSkills.length >= 12}
                    onChange={(e) => patch({ skills: e.target.checked ? [...selectedSkills, s.name] : selectedSkills.filter((name) => name !== s.name) })} />)}
                </div>
              </fieldset>
              <Checkbox label={t('personal.openMetadata')} checked={editor.value.useOpenMetadata} onChange={(e) => patch({ useOpenMetadata: e.target.checked })} />
            </>
          )}
          <Checkbox label={t('personal.enabled')} checked={editor.value.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <div className="ui-row" style={{ gap: 6 }}><Button type="submit" variant="primary">{t('common.save')}</Button><Button type="button" onClick={() => { setEditor(null); setError(''); }}>{t('common.cancel')}</Button></div>
        </form>
      ) : (
        <>
          <strong>{t('personal.templates')}</strong>
          {PERSONAL_TEMPLATES.map((template) => {
            const exists = agents.some((a) => a.name === template.agent.name) || skills.some((s) => s.name === template.skill.name);
            return <div key={template.key} className="ui-card ui-col" style={{ padding: 8, gap: 4 }}>
              <strong>{t(`personal.template.${template.key}`)}</strong>
              <Button size="sm" disabled={exists} onClick={() => {
                if (installPersonalTemplate(template.skill, template.agent)) { setError(''); setNotice(t('personal.templateAdded')); }
                else { setNotice(''); setError(t('personal.full')); }
              }}>{t(exists ? 'personal.installed' : 'personal.useTemplate')}</Button>
            </div>;
          })}
          <strong>{t('personal.skills')} · {skills.length}/20</strong>
          {skills.length === 0 && <EmptyState title={t('personal.noSkills')} />}
          {skills.map((s) => <div key={s.name} className="ui-card ui-col" style={{ padding: 8, gap: 4 }}>
            <div className="ui-row" style={{ gap: 6 }}><Checkbox label={s.label} checked={s.enabled} onChange={(e) => savePersonalSkill({ ...s, enabled: e.target.checked })} />
              <Button size="sm" onClick={() => edit({ kind: 'skill', original: s.name, value: s })}>{t('personal.edit')}</Button>
              <Button size="sm" variant="ghost" aria-label={`${t('personal.deleteSkill')} ${s.label}`} onClick={() => deletePersonalSkill(s.name)}><Icon name="trash" /></Button>
            </div><small className="ui-muted">{s.description}</small>
          </div>)}
          <strong>{t('personal.agents')} · {agents.length}/10</strong>
          {agents.length === 0 && <EmptyState title={t('personal.noAgents')} />}
          {agents.map((a) => <div key={a.name} className="ui-card ui-col" style={{ padding: 8, gap: 4 }}>
            <div className="ui-row" style={{ gap: 6 }}><Checkbox label={a.label} checked={a.enabled} onChange={(e) => savePersonalAgent({ ...a, enabled: e.target.checked })} />
              <Button size="sm" onClick={() => edit({ kind: 'agent', original: a.name, value: a })}>{t('personal.edit')}</Button>
              <Button size="sm" variant="ghost" aria-label={`${t('personal.deleteAgent')} ${a.label}`} onClick={() => deletePersonalAgent(a.name)}><Icon name="trash" /></Button>
            </div><small className="ui-muted">{a.description}</small><small>{t('personal.skillCount', { n: a.skills.length })}</small>
          </div>)}
        </>
      )}
    </div>
  );
}
