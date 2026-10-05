import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { autocompletion, completionKeymap, closeBrackets, type CompletionSource } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { sql, type SQLNamespace } from '@codemirror/lang-sql';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { DriverType } from '@vnpay/shared';
import { completionSources, dialectFor } from './completion';
import { splitStatements, statementAt } from './sqlSplit';

export { dialectFor };

/** What Run acts on: the selection if any, else the statement under the cursor. */
export interface RunTarget { sql: string; from: number; selection: boolean }

export interface SqlEditorHandle {
  /** selection, else the statement at the cursor (null: nothing to run) */
  runTarget(): RunTarget | null;
  /** the whole buffer */
  all(): RunTarget;
  /** format the selection (or everything) */
  format(): Promise<void>;
  focus(): void;
  /** insert at the cursor (replacing the selection) */
  insert(text: string): void;
  selectionText(): string;
}

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  driver?: DriverType;
  /** loaded-metadata namespace (or a getter, read on every completion); the only source of object completions (keywords/snippets are added) */
  namespace: SQLNamespace | (() => SQLNamespace);
  /** schema whose tables are offered unqualified */
  defaultSchema?: string | null;
  /** extra completion sources (FK join conditions, lazy column loading) */
  sources?: CompletionSource[];
  onRun?: () => void;
  /** run into a new result tab (Mod-Shift-Enter) */
  onRunNew?: () => void;
  /** run every statement of the buffer (Alt-X) */
  onRunScript?: () => void;
  /** execution plan of the current statement (Mod-Shift-E) */
  onExplain?: () => void;
  /** save the buffer as a file (Mod-S) */
  onSave?: () => void;
  /** a formatting failure (unsupported syntax) */
  onFormatError?: (message: string) => void;
  /** absolute offset of the last error reported by the database (wavy underline); null clears */
  errorPos?: number | null;
  ariaLabel: string;
}

/** SQL colors from the design tokens (--ui-syn-*), so both themes follow the app palette */
const sqlHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword], color: 'var(--ui-syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: 'var(--ui-syn-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--ui-syn-number)' },
  { tag: [tags.operator, tags.punctuation, tags.derefOperator], color: 'var(--ui-syn-op)' },
  { tag: [tags.typeName, tags.standard(tags.name), tags.function(tags.variableName)], color: 'var(--ui-syn-name)' },
  { tag: [tags.special(tags.name), tags.propertyName, tags.labelName], color: 'var(--ui-syn-name)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--ui-syn-comment)', fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--ui-danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--ui-canvas)', color: 'var(--ui-text)' },
  '.cm-scroller': { fontFamily: 'var(--ui-font-mono)', overflow: 'auto', lineHeight: '1.65' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--ui-link)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-link)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--ui-canvas)', color: 'var(--ui-text-subtle)', border: 'none', paddingLeft: '6px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 4px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ui-hover) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ui-text)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--ui-focus) 28%, transparent) !important' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--ui-focus) 22%, transparent)', outline: '1px solid color-mix(in srgb, var(--ui-focus) 45%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--ui-surface)', color: 'var(--ui-text)', border: '1px solid var(--ui-border-strong)', borderRadius: '6px', boxShadow: 'var(--ui-shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul': { fontFamily: 'var(--ui-font-mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete ul li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--ui-sel-bg)', color: 'var(--ui-sel-text)' },
  '.cm-completionDetail': { color: 'var(--ui-text-subtle)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-sqlError': { textDecoration: 'underline wavy var(--ui-danger)', textDecorationSkipInk: 'none', backgroundColor: 'color-mix(in srgb, var(--ui-danger) 12%, transparent)' },
  '.cm-sqlErrorLine': { backgroundColor: 'color-mix(in srgb, var(--ui-danger) 7%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--ui-surface-2)', color: 'var(--ui-text)' },
  '.cm-panels input, .cm-panels button': { font: 'inherit' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--ui-warning) 30%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--ui-primary) 15%, transparent)' },
});

const setError = StateEffect.define<number | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setError)) continue;
      if (e.value === null || e.value < 0 || e.value > tr.state.doc.length) { deco = Decoration.none; continue; }
      const pos = e.value;
      const line = tr.state.doc.lineAt(pos);
      const rest = tr.state.doc.sliceString(pos, line.to);
      const len = Math.max(1, /^[\w$#."]+/.exec(rest)?.[0].length ?? 1);
      const to = Math.min(line.to, pos + len);
      deco = Decoration.set([
        Decoration.line({ class: 'cm-sqlErrorLine' }).range(line.from),
        ...(to > pos ? [Decoration.mark({ class: 'cm-sqlError' }).range(pos, to)] : []),
      ]);
    }
    // editing the buffer invalidates the marker
    if (tr.docChanged) deco = Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const FORMAT_LANGUAGE: Record<string, string> = { postgresql: 'postgresql', oracle: 'plsql', trino: 'trino' };

/** Pretty-prints SQL (sql-formatter is loaded on first use to keep it out of the startup bundle). */
export async function formatSql(text: string, driver?: DriverType): Promise<string> {
  const { format } = await import('sql-formatter');
  return format(text, { language: (FORMAT_LANGUAGE[driver ?? ''] ?? 'sql') as never, keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 });
}

/**
 * CodeMirror 6 SQL editor. Completions: schema objects from loaded metadata only (no invented tables), keywords of the
 * dialect, saved snippets, FK join conditions. Run acts on the selection or the statement under the cursor.
 */
export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  const { value, driver, namespace, sources, errorPos, ariaLabel } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const cbs = useRef(props);
  cbs.current = props;

  const langExt = () => {
    const dialect = dialectFor(driver);
    return [
      sql({ dialect, ...(typeof namespace === 'function' ? {} : { schema: namespace }) }),
      autocompletion({ override: completionSources(dialect, namespace, sources ?? [], () => cbs.current.defaultSchema) }),
    ];
  };

  const target = (whole: boolean): RunTarget | null => {
    const v = view.current;
    if (!v) return null;
    const doc = v.state.doc.toString();
    if (whole) return { sql: doc, from: 0, selection: false };
    const sel = v.state.selection.main;
    if (!sel.empty) return { sql: v.state.sliceDoc(sel.from, sel.to), from: sel.from, selection: true };
    const st = statementAt(splitStatements(doc, cbs.current.driver), sel.head);
    return st ? { sql: st.text, from: st.from, selection: false } : null;
  };

  const format = async () => {
    const v = view.current;
    if (!v) return;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : sel.from, to = sel.empty ? v.state.doc.length : sel.to;
    const text = v.state.sliceDoc(from, to);
    if (!text.trim()) return;
    try {
      const out = await formatSql(text, cbs.current.driver);
      if (view.current !== v) return;
      v.dispatch({ changes: { from, to, insert: out }, selection: sel.empty ? undefined : EditorSelection.range(from, from + out.length) });
    } catch (e) { cbs.current.onFormatError?.((e as Error).message ?? String(e)); }
  };

  useImperativeHandle(ref, () => ({
    runTarget: () => target(false),
    all: () => target(true)!,
    format,
    focus: () => view.current?.focus(),
    insert: (text: string) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    selectionText: () => { const v = view.current; if (!v) return ''; const s = v.state.selection.main; return v.state.sliceDoc(s.from, s.to); },
  }));

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), closeBrackets(), highlightSelectionMatches(),
          syntaxHighlighting(sqlHighlight, { fallback: true }),
          errorField,
          lang.current.of(langExt()),
          keymap.of([
            { key: 'Mod-Shift-Enter', run: () => { cbs.current.onRunNew?.(); return true; } },
            { key: 'Mod-Enter', run: () => { cbs.current.onRun?.(); return true; } },
            { key: 'Alt-x', run: () => { cbs.current.onRunScript?.(); return true; } },
            { key: 'Mod-Shift-e', run: () => { cbs.current.onExplain?.(); return true; } },
            { key: 'Mod-Shift-f', run: () => { void format(); return true; } },
            { key: 'Mod-s', run: () => { cbs.current.onSave?.(); return true; }, preventDefault: true },
            { key: 'Mod-/', run: toggleComment },
            ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, 'aria-multiline': 'true' }),
          EditorView.updateListener.of((u) => { if (u.docChanged) cbs.current.onChange(u.state.doc.toString()); }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: lang.current.reconfigure(langExt()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, namespace, sources]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const pos = errorPos ?? null;
    v.dispatch({ effects: [setError.of(pos), ...(pos !== null && pos >= 0 && pos <= v.state.doc.length ? [EditorView.scrollIntoView(pos, { y: 'center' })] : [])] });
  }, [errorPos]);

  return <div ref={host} style={{ height: '100%', minHeight: 0 }} />;
});
