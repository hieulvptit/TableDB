import { useEffect, useRef } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { createGateway } from '../../gateway';
import { openConnection } from './connect';
import { usesSso, validateCustomForm } from './custom';
import { customProfiles, dedupeLocalProfiles, formFromProfile, loadLocalProfiles, loadOpenProfileIds, saveOpenProfileIds } from './profiles';
import { useTableDb } from './store';

/**
 * A refresh loses the page's sessions (they are closed on boot: the sidecar outlives the WebView). Remember which saved connections were open and reopen them on mount
 * (only those whose password is saved, or that need none); the rest stay in the saved list for a manual connect.
 */
export function useRestoreConnections() {
  const db = useTableDb();
  const { can } = useAuth();
  const dbRef = useRef(db); dbRef.current = db;
  const restored = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      // entries saved twice by earlier versions (one per connect / import) are merged before anything is reopened
      dbRef.current.remapProfiles(await dedupeLocalProfiles().catch(() => new Map<string, string>()));
      const ids = loadOpenProfileIds();
      const profiles = customProfiles(loadLocalProfiles());
      const gateway = createGateway();
      // the sidecar outlives the WebView: sessions of the previous page load would pile up to its session limit
      if (dbRef.current.connections.length === 0) await gateway.closeAllSessions().catch(() => 0);
      for (const id of ids) {
        const p = profiles.find((x) => x.id === id);
        if (!p) continue;
        try {
          const form = await formFromProfile(p);
          // SSO would pop a browser login on every refresh: those are reconnected by hand
          if (usesSso(form) || !form.password || validateCustomForm(form).length > 0) continue;
          const conn = await openConnection({ custom: form, canWrite: can('db:write') }, undefined, gateway);
          conn.profileId = p.id;
          dbRef.current.addConnection(conn);
        } catch { /* best effort: the profile stays in the saved list */ }
      }
      restored.current = true;
      saveOpenProfileIds(dbRef.current.connections.map((c) => c.profileId).filter((x): x is string => !!x));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const key = db.connections.map((c) => c.profileId ?? '').join('|');
  useEffect(() => {
    if (!restored.current) return;
    saveOpenProfileIds(db.connections.map((c) => c.profileId).filter((x): x is string => !!x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
