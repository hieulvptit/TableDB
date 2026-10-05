import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, EmptyState } from '@vnpay/ui';
import { t } from '../i18n';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  state2 = { stack: '' };
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error.message, info.componentStack);
    // development builds only: show what actually failed (never in production bundles)
    if (import.meta.env.DEV) this.setState2(`${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}\n--- component stack${info.componentStack ?? ''}`.slice(0, 2500));
  }
  private setState2(stack: string) { this.state2 = { stack }; this.forceUpdate(); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 32 }}>
        <EmptyState title={t('eb.title')}
          action={<Button variant="primary" onClick={() => { this.setState({ error: null }); }}>{t('eb.retry')}</Button>} />
        {import.meta.env.DEV && (
          <pre data-testid="eb-details" style={{ marginTop: 16, padding: 12, maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', background: 'rgba(127,127,127,.12)', borderRadius: 6 }}>
            {this.state2.stack || `${this.state.error.name}: ${this.state.error.message}`}
          </pre>
        )}
      </div>
    );
  }
}
