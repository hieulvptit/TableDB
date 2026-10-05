import { useRef, useState } from 'react';
import { Button, Spinner, useToast } from '@vnpay/ui';
import { t } from '../i18n';
import { cancelGenaiLogin, desktopGenaiLogin, genaiErrorMessage, isGenaiCancelled } from './desktopLogin';

type Phase = 'idle' | 'waiting' | 'exchanging';

/** Desktop-only: single "VNPAY SSO" button (broker flow) with a waiting state and cancel. */
export default function GenaiLoginPanel({ loginUrl, onDone }: { loginUrl: string; onDone: () => Promise<void> | void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const running = useRef(false);

  const start = async () => {
    if (running.current) return;
    running.current = true;
    setPhase('waiting');
    try {
      await desktopGenaiLogin(loginUrl, undefined, () => setPhase('exchanging'));
      await onDone();
    } catch (e) {
      if (!isGenaiCancelled(e)) toast.push(genaiErrorMessage(e), 'error');
    } finally {
      running.current = false;
      setPhase('idle');
    }
  };

  return (
    <div className="ui-col">
      <Button variant="primary" onClick={() => void start()} loading={phase !== 'idle'} disabled={phase !== 'idle'}>{t('login.genai.button')}</Button>
      {phase !== 'idle' && (
        <div className="ui-row" role="status"><Spinner label="" /> {phase === 'waiting' ? t('login.genai.waiting') : t('login.genai.exchanging')}</div>
      )}
      {phase === 'waiting' && <Button onClick={() => void cancelGenaiLogin().catch(() => {})}>{t('login.genai.cancel')}</Button>}
    </div>
  );
}
