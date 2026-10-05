import { CustomConnect } from './CustomConnect';

/** Connection manager: every user creates their own connections; they are saved locally only (never shared). */
export function ConnectPanel({ onConnected, initial }: { onConnected?: () => void; initial?: { id: string; connect?: boolean } }) {
  return <CustomConnect onConnected={onConnected} initial={initial} />;
}
