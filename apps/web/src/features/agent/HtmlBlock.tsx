import { useEffect, useRef, useState } from 'react';
import { Button, useToast } from '@vnpay/ui';
import { t } from '../../i18n';

/**
 * Only `allow-scripts`, so a visual can draw (canvas/SVG/DOM) but nothing else: no allow-same-origin (opaque origin: no cookies,
 * storage or parent DOM), no allow-forms / popups / top-navigation / downloads / modals / pointer-lock. The sandbox page's CSP blocks all network.
 */
const SANDBOX = 'allow-scripts';
/** Desktop (Tauri): custom `agent-sandbox` scheme with its own CSP (inline script, no network). Browser/dev: the static page in /public. */
function sandboxSrc(): string {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return /Windows/i.test(navigator.userAgent) ? 'http://agent-sandbox.localhost/' : 'agent-sandbox://localhost/';
  }
  return `${import.meta.env.BASE_URL}agent-sandbox.html`.replace(/\/{2,}/g, '/');
}
const SRC = sandboxSrc();
const MIN_H = 160, MAX_H = 640;

/** HTML/SVG/JS visual (e.g. a chart) written by the Agent, rendered in the isolated agent-sandbox page. */
export function HtmlBlock({ code }: { code: string }) {
  const toast = useToast();
  const [showCode, setShowCode] = useState(false);
  const [height, setHeight] = useState(300);
  const frame = useRef<HTMLIFrameElement>(null);
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'render', html: code }, '*');

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      if (e.data.type === 'agent-sandbox-ready') send();
      else if (e.data.type === 'agent-sandbox-height' && Number.isFinite(e.data.h)) setHeight(Math.max(MIN_H, Math.min(MAX_H, Math.ceil(e.data.h))));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, showCode]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); toast.push(t('agent.copied'), 'success'); } catch { toast.push(t('agent.copyFail'), 'error'); }
  };
  return (
    <div className="ui-card agent-html">
      <div className="agent-html__bar">
        <span className="ui-label">{t('agent.htmlTitle')}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => setShowCode((v) => !v)} aria-pressed={showCode}>{showCode ? t('agent.htmlPreview') : t('agent.htmlSource')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>{t('agent.copy')}</Button>
      </div>
      {showCode
        ? <pre className="ui-mono" style={{ margin: 0, padding: 8, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{code}</pre>
        : <iframe ref={frame} className="agent-html__frame" style={{ height }} title={t('agent.htmlTitle')} sandbox={SANDBOX} referrerPolicy="no-referrer" src={SRC} onLoad={send} />}
    </div>
  );
}
