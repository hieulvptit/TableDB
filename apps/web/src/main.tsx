import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vnpay/ui/styles.css';
import './app.css';
import { RuntimeContext } from './runtime/RuntimeContext';

async function bootstrap() {
  // The comparison is a build-time constant: the other target's boot module (and everything it imports) is not bundled.
  const boot = import.meta.env.VITE_TARGET === 'desktop' ? await import('./desktop/boot') : await import('./web/boot');
  const { App, runtime } = await boot.start();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RuntimeContext.Provider value={runtime}>
        <App />
      </RuntimeContext.Provider>
    </StrictMode>,
  );
}
void bootstrap();
