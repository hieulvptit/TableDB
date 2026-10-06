import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Badge, Button, Spinner, Tree, useToast, type TreeNode } from '@vnpay/ui';
import { t } from '../../i18n';
import { schemaKey, tableKey, type TableRef } from './schemaStore';
import { ContextMenu, runShortcut, type MenuItem } from './ContextMenu';
import { TableTools, type InfoTab, type ToolRequest } from './TableTools';
import { callTemplate, listObjects, objectKinds, type DbObject, type ObjectKind } from './objects';
import { ErDialog, SourceDialog } from './ObjectTools';
import { qualified, quoteIdent, selectStarSql } from './tableSql';
import { useTableDbSelector, type TableDbApi } from './store';
import type { Connection } from './types';

type Meta = { kind: 'catalog'; catalog: string } | { kind: 'schema'; catalog?: string; schema: string } | { kind: 'table'; ref: TableRef; type: string } | { kind: 'column' }
  | { kind: 'folder'; catalog?: string; schema: string; objKind: ObjectKind } | { kind: 'object'; catalog?: string; schema: string; obj: DbObject };
const objKey = (c: string | undefined, s: string, k: ObjectKind) => `obj\u0001${schemaKey(c, s)}\u0001${k}`;
const idC = (c: string) => `c\u0001${c}`;
const idS = (c: string | undefined, s: string) => `s\u0001${schemaKey(c, s)}`;
const idT = (r: TableRef) => `t\u0001${tableKey(r)}`;

export { quoteIdent, selectStarSql };

export function useStoreVersion(c: Connection | null) {
  useSyncExternalStore(c ? c.store.subscribe : noopSub, c ? c.store.getVersion : zero);
}
const noopSub = () => () => {};
const zero = () => 0;
const treeState = (db: TableDbApi) => ({ connections: db.connections, selected: db.selected, setSelected: db.setSelected, setActiveConn: db.setActiveConn, openTable: db.openTable, insertSql: db.insertSql, newTab: db.newTab, setSchema: db.setSchema });
const insertState = (db: TableDbApi) => ({ insertSql: db.insertSql });

/** true when any already-loaded schema/table name of this connection contains `q` (lower-case) */
export function storeHasMatch(store: Connection['store'], q: string): boolean {
  const has = (n: string) => n.toLowerCase().includes(q);
  const inCatalog = (c: string | undefined) => (store.schemas(c)?.value ?? []).some((s) => has(s) || (store.tables(c, s)?.value ?? []).some((tb) => has(tb.name)));
  const cats = store.catalogs()?.value ?? [];
  return cats.length > 0 ? cats.some((c) => has(c) || inCatalog(c)) : inCatalog(undefined);
}

export function SchemaTree({ conn, embedded = false, filter = '' }: { conn: Connection; embedded?: boolean; filter?: string }) {
  const db = useTableDbSelector(treeState);
  const toast = useToast();
  useStoreVersion(conn);
  const store = conn.store;
  const [tool, setTool] = useState<ToolRequest | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<TableRef | null>(null);
  const [source, setSource] = useState<{ schema: string; obj: DbObject } | null>(null);
  const [er, setEr] = useState<{ catalog?: string; schema: string; focus?: TableRef } | null>(null);
  const kinds = objectKinds(conn.driver);
  const loadFolder = useCallback((c: string | undefined, s: string, k: ObjectKind, force = false) => store.loadExtra(objKey(c, s, k), () => listObjects(conn, s, k), force), [store, conn]);

  useEffect(() => { void (async () => {
    const cats = await store.loadCatalogs();
    if (cats && cats.length === 0) await store.loadSchemas(undefined);
  })(); }, [store]);

  const q = filter.trim().toLowerCase();
  const { nodes, metas, forced } = useMemo(() => {
    const metas = new Map<string, Meta>();
    const columnsOf = (ref: TableRef): TreeNode[] => {
      const e = store.columns(ref);
      if (!e || e.status === 'loading') return [];
      if (e.status === 'error') return [];
      const pk = new Set(e.value?.primaryKey ?? []);
      const fk = new Set((e.value?.foreignKeys ?? []).flatMap((f) => f.columns));
      return (e.value?.columns ?? []).map((c) => {
        const id = `${idT(ref)}\u0002${c.name}`;
        metas.set(id, { kind: 'column' });
        return {
          id, text: `${c.name} ${c.typeName}`,
          label: <span><span className="ui-mono">{c.name}</span> <span className="ui-muted">{c.typeName}{c.nullable === false ? ' NOT NULL' : ''}</span></span>,
          badge: <>{pk.has(c.name) && <Badge tone="warning" title={t('tree.pk')}>PK</Badge>}{fk.has(c.name) && <Badge tone="info" title={t('tree.fk')}>FK</Badge>}</>,
        } satisfies TreeNode;
      });
    };
    const tablesOf = (catalog: string | undefined, schema: string): TreeNode[] => {
      const e = store.tables(catalog, schema);
      return (e?.value ?? []).map((tb) => {
        const ref: TableRef = { catalog, schema, name: tb.name };
        const id = idT(ref);
        metas.set(id, { kind: 'table', ref, type: tb.type });
        const ce = store.columns(ref);
        return {
          id, text: tb.name, expandable: true, children: columnsOf(ref), loading: ce?.status === 'loading', error: ce?.status === 'error' ? ce.error : undefined,
          label: <span>{tb.name}</span>, badge: <Badge>{/view/i.test(tb.type) ? 'VIEW' : 'TABLE'}</Badge>,
        } satisfies TreeNode;
      });
    };
    const schemasOf = (catalog: string | undefined): TreeNode[] => {
      const e = store.schemas(catalog);
      return (e?.value ?? []).map((s) => {
        const id = idS(catalog, s);
        metas.set(id, { kind: 'schema', catalog, schema: s });
        const te = store.tables(catalog, s);
        // other object kinds as lazily loaded folders after the tables
        const folders: TreeNode[] = te?.status === 'ready' ? kinds.map((k) => {
          const fid = `f\u0001${schemaKey(catalog, s)}\u0001${k}`;
          metas.set(fid, { kind: 'folder', catalog, schema: s, objKind: k });
          const fe = store.extra<DbObject[]>(objKey(catalog, s, k));
          const children = (fe?.value ?? []).map((o) => {
            const oid = `${fid}\u0002${o.oid ?? o.name}`;
            metas.set(oid, { kind: 'object', catalog, schema: s, obj: o });
            return { id: oid, text: o.name, label: <span className="ui-mono">{o.name}</span>, badge: <>{o.status && o.status !== 'VALID' && o.status !== 'ENABLED' ? <Badge tone="danger">{o.status}</Badge> : null}{o.detail ? <span className="ui-muted" style={{ fontSize: 11 }}>{o.detail}</span> : null}</> } satisfies TreeNode;
          });
          return { id: fid, text: t(`obj.kind.${k}`), expandable: true, children, loading: fe?.status === 'loading', error: fe?.status === 'error' ? fe.error : undefined,
            label: <span className="ui-muted">{t(`obj.kind.${k}`)}{fe?.status === 'ready' ? ` (${fe.value?.length ?? 0})` : ''}</span> } satisfies TreeNode;
        }) : [];
        return { id, text: s, expandable: true, children: [...tablesOf(catalog, s), ...folders], loading: te?.status === 'loading', error: te?.status === 'error' ? te.error : undefined, label: <span>{s}</span> } satisfies TreeNode;
      });
    };
    const cats = store.catalogs();
    let nodes: TreeNode[] = [];
    if (cats?.status === 'ready' && (cats.value?.length ?? 0) > 0) {
      nodes = cats.value!.map((c) => {
        const id = idC(c);
        metas.set(id, { kind: 'catalog', catalog: c });
        const se = store.schemas(c);
        return { id, text: c, expandable: true, children: schemasOf(c), loading: se?.status === 'loading', error: se?.status === 'error' ? se.error : undefined, label: <strong>{c}</strong> } satisfies TreeNode;
      });
    } else if (cats?.status === 'ready') nodes = schemasOf(undefined);
    const forced = new Set<string>();
    if (q) {
      const prune = (list: TreeNode[]): TreeNode[] => list.flatMap((n) => {
        if (metas.get(n.id)?.kind === 'column') return [n];
        if ((n.text ?? '').toLowerCase().includes(q)) return [n];
        const kids = n.children ? prune(n.children) : [];
        if (kids.length === 0) return [];
        forced.add(n.id);
        return [{ ...n, children: kids }];
      });
      nodes = prune(nodes);
    }
    return { nodes, metas, forced };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, store.getVersion(), q]);
  const shownExpanded = useMemo(() => (forced.size ? new Set([...expanded, ...forced]) : expanded), [expanded, forced]);

  const onToggle = useCallback((id: string) => {
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(id)) { n.delete(id); return n; }
      n.add(id);
      return n;
    });
    const m = metas.get(id);
    if (!m) return;
    if (m.kind === 'catalog') void store.loadSchemas(m.catalog);
    else if (m.kind === 'schema') void store.loadTables(m.catalog, m.schema);
    else if (m.kind === 'table') void store.loadColumns(m.ref);
    else if (m.kind === 'folder') void loadFolder(m.catalog, m.schema, m.objKind);
  }, [metas, store, loadFolder]);

  // Auto-expand a lone catalog's schemas lazily is intentionally not done: users choose what gets loaded.
  const selectedIds = useMemo(() => new Set(db.selected.map((r) => idT(r))), [db.selected]);

  const onSelect = (id: string, _n: TreeNode, ev: { ctrl: boolean; shift: boolean }) => {
    const m = metas.get(id);
    if (embedded) db.setActiveConn(conn.id);
    if (m?.kind === 'object') { setSource({ schema: m.schema, obj: m.obj }); return; }
    // plain click on a catalog / schema / folder row expands it (and lazily loads its children), like the caret
    if (m && (m.kind === 'catalog' || m.kind === 'schema' || m.kind === 'folder') && !ev.ctrl && !ev.shift) { onToggle(id); return; }
    if (!m || m.kind !== 'table') return;
    setDetail(m.ref);
    void store.loadColumns(m.ref); // metadata for the Agent context is loaded on demand for selected tables
    if (ev.ctrl || ev.shift) {
      const has = db.selected.some((r) => tableKey(r) === tableKey(m.ref));
      db.setSelected(has ? db.selected.filter((r) => tableKey(r) !== tableKey(m.ref)) : [...db.selected, m.ref]);
    } else {
      db.setSelected([m.ref]);
      db.openTable(m.ref); // plain click opens (or focuses) the table's data tab, like DBeaver
    }
  };

  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast.push(t('tree.copied'), 'success'), () => {}); };
  const menuItems = (id: string): MenuItem[] => {
    const m = metas.get(id);
    if (!m) return [];
    const items: MenuItem[] = [];
    if (m.kind === 'table') {
      const q = qualified(m.ref, conn.driver);
      const info = (tab: InfoTab) => () => { setDetail(m.ref); setTool({ kind: 'info', tab, ref: m.ref }); };
      const isView = m.type && /view/i.test(m.type);
      items.push(
        { key: 'data', label: t('tree.menu.viewData'), shortcut: 'F4', onSelect: () => db.openTable(m.ref) },
        { key: 'select', label: t('tree.menu.select'), shortcut: 'Alt+S', onSelect: () => { setDetail(m.ref); db.insertSql(selectStarSql(m.ref, conn.driver)); } },
        { key: 'count', label: t('tree.menu.count'), shortcut: 'Alt+C', onSelect: () => db.insertSql(`SELECT COUNT(*) FROM ${q}`) },
        { key: 's0', label: '', separator: true },
        { key: 'details', label: t('tree.menu.details'), shortcut: 'F3', onSelect: info('columns') },
        { key: 'ddl', label: t('tree.menu.ddl'), shortcut: 'Alt+L', onSelect: info('ddl') },
        { key: 'indexes', label: t('tree.menu.indexes'), shortcut: 'Alt+I', disabled: !!isView, onSelect: info('indexes') },
        { key: 'partitions', label: t('tree.menu.partitions'), shortcut: 'Alt+P', disabled: !!isView, onSelect: info('partitions') },
        { key: 'props', label: t('tree.menu.properties'), shortcut: 'Alt+Enter', onSelect: info('properties') },
        { key: 's2', label: '', separator: true },
        { key: 'export', label: t('tree.menu.export'), shortcut: 'Alt+E', onSelect: () => setTool({ kind: 'export', ref: m.ref }) },
        { key: 'import', label: t('tree.menu.import'), shortcut: 'Alt+M', disabled: !conn.allowWrite || !!isView, onSelect: () => setTool({ kind: 'import', ref: m.ref }) },
        { key: 's1', label: '', separator: true },
        { key: 'sel', label: t('tree.menu.addContext'), shortcut: 'Alt+A', onSelect: () => { void store.loadColumns(m.ref); if (!db.selected.some((r) => tableKey(r) === tableKey(m.ref))) db.setSelected([...db.selected, m.ref]); } },
        { key: 'copy', label: t('tree.menu.copyName'), shortcut: 'Mod+C', onSelect: () => copy(q) },
        { key: 'copyddl', label: t('tree.menu.copyDdl'), shortcut: 'Mod+Shift+C', onSelect: () => { void store.loadDdl(m.ref).then((d) => { if (d) copy(d); }); } },
        { key: 'refresh', label: t('tree.menu.refresh'), shortcut: 'F5', onSelect: () => { void store.loadColumns(m.ref, true); void store.loadDdl(m.ref, true); } },
        { key: 'er', label: t('er.related'), shortcut: 'Alt+R', onSelect: () => setEr({ catalog: m.ref.catalog, schema: m.ref.schema, focus: m.ref }) },
      );
    } else if (m.kind === 'folder') {
      items.push({ key: 'refresh', label: t('tree.menu.refresh'), shortcut: 'F5', onSelect: () => { void loadFolder(m.catalog, m.schema, m.objKind, true); setExpanded((c) => new Set(c).add(id)); } });
    } else if (m.kind === 'object') {
      const o = m.obj;
      items.push(
        { key: 'src', label: t('obj.viewSource'), shortcut: 'F4', onSelect: () => setSource({ schema: m.schema, obj: o }) },
        ...(['procedures', 'functions', 'sequences'].includes(o.kind) ? [{ key: 'call', label: t('obj.insertCall'), shortcut: 'Alt+C', onSelect: () => db.insertSql(callTemplate(conn.driver, m.schema, o)) }] : []),
        ...(o.kind === 'synonyms' || o.kind === 'mviews' ? [{ key: 'sel', label: t('tree.menu.select'), shortcut: 'Alt+S', onSelect: () => db.insertSql(selectStarSql({ catalog: m.catalog, schema: m.schema, name: o.name }, conn.driver)) }] : []),
        { key: 'copy', label: t('tree.menu.copyName'), shortcut: 'Mod+C', onSelect: () => copy(o.kind === 'functions' || o.kind === 'procedures' ? o.name.replace(/\(.*$/, '') : o.name) },
      );
    } else if (m.kind === 'column') {
      const name = id.slice(id.lastIndexOf('\u0002') + 1);
      items.push({ key: 'insert', label: t('tree.menu.insertName'), shortcut: 'Alt+I', onSelect: () => db.insertSql(quoteIdent(name, conn.driver)) }, { key: 'copy', label: t('tree.menu.copyName'), shortcut: 'Mod+C', onSelect: () => copy(name) });
    } else {
      const name = m.kind === 'catalog' ? m.catalog : m.schema;
      items.push(
        { key: 'refresh', label: t('tree.menu.refresh'), shortcut: 'F5', onSelect: () => { if (m.kind === 'catalog') void store.loadSchemas(m.catalog, true); else { void store.loadTables(m.catalog, m.schema, true); for (const k of kinds) if (store.extra(objKey(m.catalog, m.schema, k))) void loadFolder(m.catalog, m.schema, k, true); } setExpanded((c) => new Set(c).add(id)); } },
        { key: 'copy', label: t('tree.menu.copyName'), shortcut: 'Mod+C', onSelect: () => copy(name) },
        ...(m.kind === 'schema' ? [
          { key: 's9', label: '', separator: true },
          { key: 'newsql', label: t('obj.newQueryHere'), shortcut: 'Alt+N', onSelect: () => db.newTab('', { connId: conn.id, schema: m.schema, ...(m.catalog ? { catalog: m.catalog } : {}), title: m.schema }) },
          { key: 'def', label: t('obj.setDefaultSchema'), shortcut: 'Alt+D', disabled: conn.currentSchema === m.schema, onSelect: () => void db.setSchema(conn.id, m.schema) },
          { key: 'er', label: t('er.schema'), shortcut: 'Alt+R', onSelect: () => setEr({ catalog: m.catalog, schema: m.schema }) },
        ] : []),
      );
    }
    return items;
  };
  const onContextMenu = (id: string, _n: TreeNode, pos: { x: number; y: number }) => {
    const items = menuItems(id);
    if (items.length) setMenu({ ...pos, items });
  };
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const id = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id');
    if (id) runShortcut(menuItems(id), e);
  };

  const cats = store.catalogs();
  return (
    <div style={embedded ? undefined : { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {!embedded && <div className="ui-row" style={{ padding: '6px 8px', borderBottom: '1px solid var(--ui-border)' }}>
        <strong style={{ flex: 1 }}>{t('tree.title')}</strong>
        <Button size="sm" variant="ghost" onClick={() => { store.clear(); void store.loadCatalogs(true).then((c) => c && c.length === 0 ? store.loadSchemas(undefined, true) : undefined); }} aria-label={t('tree.refresh')} title={t('tree.refresh')}>⟳</Button>
      </div>}
      <div onKeyDown={onTreeKeyDown} style={embedded ? { padding: '0 0 4px 14px' } : { flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
        {cats?.status === 'loading' && <div className="ui-row" style={{ padding: 8 }}><Spinner label={t('common.loading')} /> {t('common.loading')}</div>}
        {cats?.status === 'error' && <div className="ui-error-text" role="alert" style={{ padding: 8 }}>{cats.error}</div>}
        <Tree label={t('tree.title')} nodes={nodes} expanded={shownExpanded} onToggle={onToggle} selected={selectedIds} onSelect={onSelect} onContextMenu={onContextMenu}
          onActivate={(id) => { const m = metas.get(id); if (m?.kind === 'table') { setDetail(m.ref); db.insertSql(selectStarSql(m.ref, conn.driver)); } }}
          emptyText={cats?.status === 'ready' ? t('tree.empty') : ''} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <TableTools conn={conn} req={tool} onClose={() => setTool(null)} />
      {source && <SourceDialog conn={conn} schema={source.schema} obj={source.obj} onClose={() => setSource(null)} />}
      {er && <ErDialog conn={conn} catalog={er.catalog} schema={er.schema} focus={er.focus} onClose={() => setEr(null)} />}
      {detail && !embedded && <TableDetails conn={conn} tableRef={detail} />}
    </div>
  );
}

function TableDetails({ conn, tableRef }: { conn: Connection; tableRef: TableRef }) {
  const db = useTableDbSelector(insertState);
  useStoreVersion(conn);
  const store = conn.store;
  const cols = store.columns(tableRef);
  const ddl = store.ddl(tableRef);
  const [showDdl, setShowDdl] = useState(false);
  useEffect(() => { setShowDdl(false); }, [tableRef.schema, tableRef.name, tableRef.catalog]);
  return (
    <section aria-label={t('tree.details')} style={{ borderTop: '1px solid var(--ui-border)', maxHeight: '45%', overflow: 'auto', padding: 8, background: 'var(--ui-surface-2)' }}>
      <div className="ui-row" style={{ flexWrap: 'wrap' }}>
        <strong className="ui-mono">{tableRef.schema}.{tableRef.name}</strong>
        <Button size="sm" onClick={() => db.insertSql(selectStarSql(tableRef, conn.driver))}>{t('tree.insertSelect')}</Button>
        <Button size="sm" onClick={() => { setShowDdl((v) => !v); void store.loadDdl(tableRef); }} aria-expanded={showDdl}>{t('tree.ddl')}</Button>
      </div>
      {cols?.status === 'loading' && <Spinner label={t('common.loading')} />}
      {cols?.status === 'error' && <div className="ui-error-text">{cols.error}</div>}
      {cols?.value && (
        <table className="ui-table" style={{ marginTop: 6 }}>
          <thead><tr><th scope="col">{t('tree.col')}</th><th scope="col">{t('tree.type')}</th><th scope="col">{t('tree.keys')}</th><th scope="col">{t('tree.remarks')}</th></tr></thead>
          <tbody>
            {cols.value.columns.map((c) => (
              <tr key={c.name}>
                <td className="ui-mono">{c.name}</td>
                <td>{c.typeName}{c.size ? `(${c.size}${c.scale ? `,${c.scale}` : ''})` : ''}{c.nullable === false ? ' NN' : ''}</td>
                <td>{cols.value!.primaryKey.includes(c.name) ? 'PK ' : ''}{cols.value!.foreignKeys.filter((f) => f.columns.includes(c.name)).map((f) => `FK→${f.refTable}`).join(' ')}</td>
                <td title={c.remarks ?? undefined}>{c.remarks ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showDdl && (
        <div style={{ marginTop: 6 }}>
          {ddl?.status === 'loading' && <Spinner label={t('common.loading')} />}
          {ddl?.status === 'error' && <div className="ui-error-text">{ddl.error}</div>}
          {ddl?.value && <pre className="ui-mono" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{ddl.value}</pre>}
        </div>
      )}
    </section>
  );
}
